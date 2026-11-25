import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoginRequiredError, RefreshRejectedError } from './errors.ts';
import { Session } from './session.ts';
import { TokenStore } from './token-store.ts';

describe('session refresh', () => {
  test('stores a new access token and keeps the same refresh token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'digitalpost-session-'));
    await chmod(dir, 0o700);
    const paths = {
      dir,
      tokenFile: join(dir, 'tokens.enc'),
      keyFile: join(dir, '.key'),
      deviceIdFile: join(dir, 'device-id'),
      downloadDir: join(dir, 'downloads'),
    };
    const store = new TokenStore({ paths, env: {} });
    await store.save({
      version: 1,
      status: 'ok',
      username: 'user',
      savedAt: 1,
      tokens: {
        accessToken: 'old-access',
        refreshToken: 'refresh-1',
        expiresAt: 0,
        tokenType: 'Bearer',
      },
    });
    const calls: string[] = [];
    const session = new Session({
      store,
      now: () => 5_000,
      fetchImpl: async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        expect(String(url)).not.toContain('/apis/v1');
        return Response.json({
          access_token: 'new-access',
          expires_in: 1200,
          token_type: 'Bearer',
        });
      },
    });
    const token = await session.accessToken();
    expect(token).toBe('new-access');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.startsWith('POST https://digitalpost.dk/auth/oauth/token')).toBe(true);
    const stored = await store.load();
    expect(stored?.tokens?.refreshToken).toBe('refresh-1');
    expect(stored?.tokens?.accessToken).toBe('new-access');
  });

  test('a rejected refresh becomes login_required', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'digitalpost-session-'));
    await chmod(dir, 0o700);
    const paths = {
      dir,
      tokenFile: join(dir, 'tokens.enc'),
      keyFile: join(dir, '.key'),
      deviceIdFile: join(dir, 'device-id'),
      downloadDir: join(dir, 'downloads'),
    };
    const store = new TokenStore({ paths, env: {} });
    await store.save({
      version: 1,
      status: 'ok',
      username: 'user',
      savedAt: 1,
      tokens: {
        accessToken: 'old-access',
        refreshToken: 'refresh-1',
        expiresAt: 0,
        tokenType: 'Bearer',
      },
    });
    const session = new Session({
      store,
      fetchImpl: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    });
    await expect(session.renew()).rejects.toBeInstanceOf(LoginRequiredError);
    const stored = await store.load();
    expect(stored?.status).toBe('login_required');
    expect(stored?.tokens?.refreshToken).toBe('refresh-1');
    const raw = await Bun.file(paths.tokenFile).text();
    expect(raw).not.toContain('refresh-1');
    const bak = new TokenStore({
      paths: { ...paths, tokenFile: `${paths.tokenFile}.bak` },
      env: {},
    });
    const previous = await bak.load();
    expect(previous?.status).toBe('ok');
    expect(previous?.tokens?.refreshToken).toBe('refresh-1');
  });

  test('a single non-grant 401 keeps the login usable', async () => {
    const { store, paths } = await tempStore();
    const session = new Session({
      store,
      fetchImpl: async () => new Response('nope', { status: 401 }),
    });
    await expect(session.renew()).rejects.toBeInstanceOf(RefreshRejectedError);
    const stored = await store.load();
    expect(stored?.status).toBe('ok');
    expect(stored?.tokens?.refreshToken).toBe('refresh-1');
    expect(stored?.refreshFailures).toBe(1);
    expect(paths.tokenFile).toBeTruthy();
  });

  test('renew --force retries a kept refresh token from login_required', async () => {
    const { store } = await tempStore();
    await store.markLoginRequired('user');
    expect((await store.load())?.status).toBe('login_required');
    const session = new Session({
      store,
      now: () => 5_000,
      fetchImpl: async () =>
        Response.json({ access_token: 'new-access', expires_in: 1200, token_type: 'Bearer' }),
    });
    await expect(session.renew()).rejects.toBeInstanceOf(LoginRequiredError);
    const renewed = await session.renew({ force: true });
    expect(renewed.expiresAt).toBeGreaterThan(5_000);
    const stored = await store.load();
    expect(stored?.status).toBe('ok');
    expect(stored?.tokens?.refreshToken).toBe('refresh-1');
    expect(stored?.tokens?.accessToken).toBe('new-access');
  });

  test('a transient token error is not retried and keeps the login', async () => {
    const { store } = await tempStore();
    for (const status of [429, 503]) {
      let reads = 0;
      const session = new Session({
        store,
        now: () => 5_000,
        fetchImpl: async () => {
          reads += 1;
          return new Response('down', { status });
        },
      });
      await expect(session.renew()).rejects.toBeInstanceOf(RefreshRejectedError);
      expect(reads).toBe(1);
      const stored = await store.load();
      expect(stored?.status).toBe('ok');
      expect(stored?.tokens?.refreshToken).toBe('refresh-1');
      expect(stored?.tokens?.accessToken).toBe('old-access');
    }

    let timeouts = 0;
    const offline = new Session({
      store,
      fetchImpl: async () => {
        timeouts += 1;
        throw new Error('timeout');
      },
    });
    await expect(offline.renew()).rejects.toBeInstanceOf(RefreshRejectedError);
    expect(timeouts).toBe(1);
    const after = await store.load();
    expect(after?.status).toBe('ok');
    expect(after?.tokens?.refreshToken).toBe('refresh-1');
    expect(after?.tokens?.accessToken).toBe('old-access');
  });

  test('the session fetch refuses a mail-API write before the network', async () => {
    const { store } = await tempStore();
    let called = false;
    const session = new Session({
      store,
      fetchImpl: async () => {
        called = true;
        return new Response('no');
      },
    });
    const fetchImpl = (
      session as unknown as {
        fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
      }
    ).fetchImpl;
    await expect(
      fetchImpl('https://gateway.digitalpost.dk/apis/v1/mailboxes/x/messages/y', {
        method: 'PATCH',
      }),
    ).rejects.toThrow(/Refusing/);
    expect(called).toBe(false);
  });
});

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'digitalpost-session-'));
  await chmod(dir, 0o700);
  const paths = {
    dir,
    tokenFile: join(dir, 'tokens.enc'),
    keyFile: join(dir, '.key'),
    deviceIdFile: join(dir, 'device-id'),
    downloadDir: join(dir, 'downloads'),
  };
  const store = new TokenStore({ paths, env: {} });
  await store.save({
    version: 1,
    status: 'ok',
    username: 'user',
    savedAt: 1,
    tokens: {
      accessToken: 'old-access',
      refreshToken: 'refresh-1',
      expiresAt: 0,
      tokenType: 'Bearer',
    },
  });
  return { store, paths };
}
