import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RefreshRejectedError } from './errors.ts';
import { startRenewLoop } from './renew-loop.ts';
import { Session } from './session.ts';
import { TokenStore } from './token-store.ts';

describe('renew loop', () => {
  test('a rejected refresh becomes login_required and a timeout does not delete the token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'digitalpost-renew-'));
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
        refreshToken: 'refresh-kept',
        expiresAt: 0,
        tokenType: 'Bearer',
      },
    });
    const rejected = new Session({
      store,
      fetchImpl: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    });
    const loop = startRenewLoop(rejected, { immediate: false, intervalMs: 60_000 });
    expect(await loop.runOnce()).toBe('login_required');
    expect((await store.load())?.status).toBe('login_required');
    expect((await store.load())?.tokens?.refreshToken).toBe('refresh-kept');
    loop.stop();

    await store.save({
      version: 1,
      status: 'ok',
      username: 'user',
      savedAt: 1,
      lastRenewAt: 1,
      tokens: {
        accessToken: 'old-access',
        refreshToken: 'refresh-kept',
        expiresAt: 0,
        tokenType: 'Bearer',
      },
    });
    const timeout = new Session({
      store,
      fetchImpl: async () => {
        throw new Error('timeout');
      },
    });
    const again = startRenewLoop(timeout, { immediate: false, intervalMs: 60_000 });
    expect(await again.runOnce()).toBe('transient');
    const stored = await store.load();
    expect(stored?.status).toBe('ok');
    expect(stored?.tokens?.refreshToken).toBe('refresh-kept');
    expect(stored?.lastRenewAt).toBe(1);
    again.stop();
    expect(RefreshRejectedError).toBeTruthy();
  });
});
