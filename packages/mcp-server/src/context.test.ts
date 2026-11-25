import { describe, expect, test } from 'bun:test';
import { DigitalPostContext } from './context.ts';

describe('mailbox cache', () => {
  test('resolveMailbox reuses the mailbox list', async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({
        mailboxes: [{ id: 'mb-citizen', ownerType: 'CITIZEN', ownerName: 'Test' }],
      });
    }) as unknown as typeof fetch;
    try {
      const dir = await import('node:fs/promises').then(({ mkdtemp }) =>
        mkdtemp('/tmp/digitalpost-ctx-'),
      );
      const context = new DigitalPostContext({
        paths: {
          dir,
          tokenFile: `${dir}/tokens.enc`,
          keyFile: `${dir}/.key`,
          deviceIdFile: `${dir}/device-id`,
          downloadDir: `${dir}/downloads`,
        },
      });
      const store = context.store;
      await store.save({
        version: 1,
        status: 'ok',
        username: 'user',
        savedAt: 1,
        tokens: {
          accessToken: 'token',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 60 * 60_000,
          tokenType: 'Bearer',
        },
      });
      const first = await context.resolveMailbox();
      const second = await context.resolveMailbox(first.id);
      expect(first.id).toBe('mb-citizen');
      expect(second.id).toBe('mb-citizen');
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('drops the cache when the refresh token changes and after five minutes', async () => {
    let calls = 0;
    let clock = 1_000;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({
        mailboxes: [{ id: 'mb-citizen', ownerType: 'CITIZEN', ownerName: 'Test' }],
      });
    }) as unknown as typeof fetch;
    try {
      const dir = await import('node:fs/promises').then(({ mkdtemp }) =>
        mkdtemp('/tmp/digitalpost-ctx-'),
      );
      const paths = {
        dir,
        tokenFile: `${dir}/tokens.enc`,
        keyFile: `${dir}/.key`,
        deviceIdFile: `${dir}/device-id`,
        downloadDir: `${dir}/downloads`,
      };
      const context = new DigitalPostContext({ paths, now: () => clock });
      await context.store.save({
        version: 1,
        status: 'ok',
        username: 'user',
        savedAt: 1,
        tokens: {
          accessToken: 'token',
          refreshToken: 'refresh-a',
          expiresAt: Date.now() + 60 * 60_000,
          tokenType: 'Bearer',
        },
      });
      await context.mailboxes();
      await context.store.save({
        version: 1,
        status: 'ok',
        username: 'user',
        savedAt: 2,
        tokens: {
          accessToken: 'token',
          refreshToken: 'refresh-b',
          expiresAt: Date.now() + 60 * 60_000,
          tokenType: 'Bearer',
        },
      });
      await context.mailboxes();
      clock += 5 * 60_000 + 1;
      await context.mailboxes();
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = original;
    }
  });
});
