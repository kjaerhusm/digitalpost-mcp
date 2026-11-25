import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type StoredLogin, TokenStore } from './token-store.ts';

const dirs: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempPaths() {
  const dir = await mkdtemp(join(tmpdir(), 'digitalpost-'));
  dirs.push(dir);
  await chmod(dir, 0o700);
  return {
    dir,
    tokenFile: join(dir, 'tokens.enc'),
    keyFile: join(dir, '.key'),
    deviceIdFile: join(dir, 'device-id'),
    downloadDir: join(dir, 'downloads'),
  };
}

const record: StoredLogin = {
  version: 1,
  status: 'ok',
  username: 'mitid-user',
  savedAt: 10,
  tokens: {
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: 99,
    tokenType: 'Bearer',
  },
};

describe('encrypted token store', () => {
  test('round-trips a login and does not write the tokens in clear text', async () => {
    const paths = await tempPaths();
    const store = new TokenStore({ paths, env: {} });
    await store.save(record);
    const loaded = await store.load();
    expect(loaded?.tokens?.refreshToken).toBe('refresh-secret');
    expect(loaded?.username).toBe('mitid-user');
    const raw = await readFile(paths.tokenFile, 'utf8');
    expect(raw).not.toContain('refresh-secret');
    expect(raw).not.toContain('access-secret');
    const info = await stat(paths.tokenFile);
    expect(info.mode & 0o777).toBe(0o600);
    const keyInfo = await stat(paths.keyFile);
    expect(keyInfo.mode & 0o777).toBe(0o600);
  });

  test('markLoginRequired keeps the refresh token and writes a backup', async () => {
    const paths = await tempPaths();
    const store = new TokenStore({ paths, env: {} });
    await store.save(record);
    await store.markLoginRequired('mitid-user');
    const loaded = await store.load();
    expect(loaded?.status).toBe('login_required');
    expect(loaded?.tokens?.refreshToken).toBe('refresh-secret');
    const bak = new TokenStore({
      paths: { ...paths, tokenFile: `${paths.tokenFile}.bak` },
      env: {},
    });
    expect((await bak.load())?.status).toBe('ok');
  });

  test('a different key cannot decrypt the file', async () => {
    const paths = await tempPaths();
    const key = Buffer.alloc(32, 1);
    await new TokenStore({ paths, key, env: {} }).save(record);
    const other = new TokenStore({ paths, key: Buffer.alloc(32, 2), env: {} });
    await expect(other.load()).rejects.toThrow(/decrypt/);
  });
});
