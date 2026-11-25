/**
 * Local login page. Bind it to 127.0.0.1 only.
 * The page shows the rotating MitID QR codes and never displays tokens.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import QRCode from 'qrcode';
import { isLoopbackHost } from './config.ts';
import type { IdentityChoice, LoginHooks } from './login.ts';

export interface LoginUiDeps {
  status: () => Promise<{ loggedIn: boolean; username: string | null; status: string }>;
  runLogin: (args: { username: string; signal: AbortSignal; hooks: LoginHooks }) => Promise<void>;
}

interface UiEvent {
  event: string;
  data: unknown;
}

class LoginSession {
  readonly id = randomUUID();
  readonly abort = new AbortController();
  private readonly queues: EventQueue[] = [];
  private readonly history: UiEvent[] = [];
  private identityWait: ((index: number) => void) | null = null;
  private closed = false;

  emit(event: string, data: unknown): void {
    const item = { event, data };
    this.history.push(item);
    for (const queue of this.queues) queue.push(item);
  }

  subscribe(): EventQueue {
    const queue = new EventQueue();
    for (const item of this.history) queue.push(item);
    if (this.closed) queue.close();
    else this.queues.push(queue);
    return queue;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    for (const queue of this.queues) queue.close();
  }

  waitForIdentity(): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for an identity choice.'));
      }, 10 * 60_000);
      this.identityWait = (index) => {
        clearTimeout(timer);
        resolve(index);
      };
    });
  }

  chooseIdentity(index: number): boolean {
    if (!this.identityWait) return false;
    this.identityWait(index);
    this.identityWait = null;
    return true;
  }
}

class EventQueue {
  private items: UiEvent[] = [];
  private waiters: Array<(event: UiEvent | null) => void> = [];
  private closed = false;

  push(event: UiEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.items.push(event);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  async next(): Promise<UiEvent | null> {
    const queued = this.items.shift();
    if (queued) return queued;
    if (this.closed) return null;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export function createLoginApp(deps: LoginUiDeps): Hono {
  const app = new Hono();
  const sessions = new Map<string, LoginSession>();

  app.use('*', async (c, next) => {
    if (!isLoopbackHost(c.req.header('host'))) {
      return c.text('This login page only answers on localhost.', 403);
    }
    await next();
  });

  app.get('/', async (c) => {
    const status = await deps.status();
    return c.html(loginPage(status));
  });

  app.get('/healthz', (c) => c.json({ ok: true, service: 'digitalpost-login' }));

  app.post('/login/start', async (c) => {
    if (!localHeader(c.req.header('x-digitalpost-login'))) {
      return c.json({ error: 'Missing local login header.' }, 403);
    }
    let body: { username?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Expected JSON.' }, 400);
    }
    const username = body.username?.trim() ?? '';
    if (!username) return c.json({ error: 'Enter your MitID username.' }, 400);

    const session = new LoginSession();
    sessions.set(session.id, session);
    const timeout = setTimeout(() => session.close(), 12 * 60_000);
    void run(session, username).finally(() => {
      clearTimeout(timeout);
      setTimeout(() => sessions.delete(session.id), 60_000);
    });
    return c.json({ sessionId: session.id });
  });

  app.get('/login/events', (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.text('sessionId is required', 400);
    const session = sessions.get(sessionId);
    if (!session) return c.text('Unknown login session', 404);
    const queue = session.subscribe();
    return streamSSE(c, async (stream) => {
      while (true) {
        const item = await queue.next();
        if (!item) break;
        await stream.writeSSE({ event: item.event, data: JSON.stringify(item.data) });
        if (item.event === 'done' || item.event === 'error') break;
      }
    });
  });

  app.post('/login/identity', async (c) => {
    if (!localHeader(c.req.header('x-digitalpost-login'))) {
      return c.json({ error: 'Missing local login header.' }, 403);
    }
    let body: { sessionId?: string; index?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Expected JSON.' }, 400);
    }
    if (!body.sessionId) return c.json({ error: 'sessionId is required' }, 400);
    const session = sessions.get(body.sessionId);
    if (!session) return c.json({ error: 'Unknown login session' }, 404);
    if (!session.chooseIdentity(Number(body.index))) {
      return c.json({ error: 'This login is not waiting for an identity choice.' }, 409);
    }
    return c.json({ ok: true });
  });

  async function run(session: LoginSession, username: string): Promise<void> {
    try {
      await deps.runLogin({
        username,
        signal: session.abort.signal,
        hooks: {
          onStatus: (message) => session.emit('status', { message }),
          onWaiting: () => session.emit('status', { message: 'Waiting for the MitID app.' }),
          onQr: async (qr) => {
            const [qr1, qr2] = await Promise.all([
              QRCode.toDataURL(qr.qr1Json, { margin: 1, width: 280 }),
              QRCode.toDataURL(qr.qr2Json, { margin: 1, width: 280 }),
            ]);
            session.emit('qr', { qr1, qr2, updateCount: qr.updateCount });
          },
          selectIdentity: async (options) => {
            session.emit('identity', {
              options: options.map((option) => ({ index: option.index, name: option.name })),
            });
            return session.waitForIdentity();
          },
        },
      });
      session.emit('done', { ok: true });
    } catch (error) {
      session.emit('error', { message: publicError(error) });
    } finally {
      session.close();
    }
  }

  return app;
}

function localHeader(value: string | undefined): boolean {
  return value === '1';
}

/** The Host header itself must be loopback. The request URL is not a substitute. */
export function isLoopbackRequest(hostHeader: string | undefined): boolean {
  return isLoopbackHost(hostHeader);
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Login failed.';
  if (message.length > 400) return 'Login failed.';
  if (/bearer|access_token|refresh_token|eyJ/i.test(message)) return 'Login failed.';
  return message;
}

function loginPage(status: { loggedIn: boolean; username: string | null; status: string }): string {
  const state = status.loggedIn
    ? `Logget ind${status.username ? ` som ${escapeHtml(status.username)}` : ''}.`
    : status.status === 'login_required'
      ? 'Den gemte login er udløbet. Log ind igen.'
      : 'Ikke logget ind.';
  return `<!doctype html>
<html lang="da">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Digital Post login</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: "Iowan Old Style", Palatino, Georgia, serif; margin: 0; background: #f4f1ea; color: #1c1915; }
    main { max-width: 40rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
    h1 { font-weight: 500; letter-spacing: -0.02em; margin-bottom: 0.25rem; }
    p.lead { color: #4a453c; }
    form, section { background: white; border: 1px solid #e4ddd0; border-radius: 16px; padding: 1.25rem; margin-top: 1rem; }
    label { display: block; font-size: 0.9rem; margin-bottom: 0.35rem; }
    input { width: 100%; box-sizing: border-box; font: inherit; padding: 0.7rem 0.8rem; border-radius: 10px; border: 1px solid #c9c0b2; }
    button { margin-top: 0.8rem; font: inherit; background: #1f4b3a; color: white; border: 0; border-radius: 999px; padding: 0.7rem 1.1rem; cursor: pointer; }
    .qrs { display: flex; gap: 1rem; flex-wrap: wrap; }
    img { width: 220px; height: 220px; background: white; border-radius: 12px; }
    .muted { color: #6b645b; font-size: 0.92rem; }
    .error { color: #8a2b2b; }
    @media (prefers-color-scheme: dark) {
      body { background: #161411; color: #f3efe6; }
      p.lead, .muted { color: #c9c1b4; }
      form, section { background: #221e19; border-color: #3a342c; }
      input { background: #161411; color: inherit; border-color: #4a433a; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Digital Post</h1>
    <p class="lead">Privat, skrivebeskyttet login til post fra det offentlige. Godkend i MitID-appen, eller scan den roterende QR-kode.</p>
    <p class="muted" id="state">${state}</p>
    <form id="login">
      <label for="username">MitID-brugernavn</label>
      <input id="username" name="username" autocomplete="username" required>
      <button type="submit">Fortsæt</button>
    </form>
    <section id="progress" hidden>
      <p id="status" class="muted">Starter…</p>
      <div class="qrs">
        <img id="qr1" alt="MitID QR-kode 1" hidden>
        <img id="qr2" alt="MitID QR-kode 2" hidden>
      </div>
      <div id="identities"></div>
      <p id="error" class="error"></p>
    </section>
  </main>
  <script>
    const headers = { 'content-type': 'application/json', 'x-digitalpost-login': '1' };
    const form = document.getElementById('login');
    const progress = document.getElementById('progress');
    const statusEl = document.getElementById('status');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      progress.hidden = false;
      document.getElementById('error').textContent = '';
      const username = document.getElementById('username').value;
      const started = await fetch('/login/start', { method: 'POST', headers, body: JSON.stringify({ username }) });
      const payload = await started.json();
      if (!started.ok) {
        document.getElementById('error').textContent = payload.error || 'Kunne ikke starte login.';
        return;
      }
      const source = new EventSource('/login/events?sessionId=' + encodeURIComponent(payload.sessionId));
      const show = (id, url) => { const img = document.getElementById(id); img.hidden = false; img.src = url; };
      source.addEventListener('status', (ev) => { statusEl.textContent = JSON.parse(ev.data).message; });
      source.addEventListener('qr', (ev) => {
        const data = JSON.parse(ev.data);
        show('qr1', data.qr1);
        show('qr2', data.qr2);
        statusEl.textContent = 'Scan QR-koden i MitID-appen (opdatering ' + data.updateCount + ').';
      });
      source.addEventListener('identity', (ev) => {
        const box = document.getElementById('identities');
        box.replaceChildren();
        for (const option of JSON.parse(ev.data).options) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = option.name;
          button.addEventListener('click', () => {
            fetch('/login/identity', { method: 'POST', headers, body: JSON.stringify({ sessionId: payload.sessionId, index: option.index }) });
          });
          box.append(button);
        }
      });
      source.addEventListener('done', () => { statusEl.textContent = 'Logget ind. Du kan lukke denne side.'; source.close(); });
      source.addEventListener('error', (ev) => {
        if (ev.data) document.getElementById('error').textContent = JSON.parse(ev.data).message;
      });
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export type { IdentityChoice };
