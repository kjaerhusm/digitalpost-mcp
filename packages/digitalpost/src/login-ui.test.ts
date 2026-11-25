import { describe, expect, test } from 'bun:test';
import { createLoginApp } from './login-ui.ts';

function local(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has('host')) headers.set('host', '127.0.0.1:8098');
  return new Request(`http://127.0.0.1:8098${path}`, { ...init, headers });
}

describe('login page', () => {
  const app = createLoginApp({
    status: async () => ({ loggedIn: false, username: null, status: 'anonymous' }),
    runLogin: async ({ hooks }) => {
      await hooks.onStatus?.('Waiting for MitID.');
      await hooks.onQr?.({ qr1Json: 'qr-one', qr2Json: 'qr-two', updateCount: 1 });
      await hooks.onStatus?.('done-internal');
    },
  });

  test('GET / is the login form and does not require a session', async () => {
    const response = await app.fetch(local('/'));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('MitID-brugernavn');
    expect(html).toContain('/login/start');
    expect(html).not.toContain('access_token');
  });

  test('refuses a non-local Host', async () => {
    const response = await app.fetch(local('/', { headers: { host: 'evil.example' } }));
    expect(response.status).toBe(403);
  });

  test('POST /login/start requires the local header and a username', async () => {
    const missing = await app.fetch(
      local('/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'person' }),
      }),
    );
    expect(missing.status).toBe(403);
    const bad = await app.fetch(
      local('/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-digitalpost-login': '1' },
        body: JSON.stringify({ username: '  ' }),
      }),
    );
    expect(bad.status).toBe(400);
  });

  test('a started login emits a QR event', async () => {
    const started = await app.fetch(
      local('/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-digitalpost-login': '1' },
        body: JSON.stringify({ username: 'person' }),
      }),
    );
    expect(started.status).toBe(200);
    const { sessionId } = (await started.json()) as { sessionId: string };
    const events = await app.fetch(local(`/login/events?sessionId=${sessionId}`));
    expect(events.status).toBe(200);
    const text = await events.text();
    expect(text).toContain('event: qr');
    expect(text).toContain('data:image/png');
    expect(text).not.toContain('qr-one');
  });
});
