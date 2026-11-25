import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { HttpClient } from '@digitalpost/mitid';
import { ReadOnlyError } from './errors.ts';
import { assertMailRead, guardedMailFetch, isMailApiUrl } from './guard.ts';

describe('read-only mail guard', () => {
  test('allows GET against the mail API', () => {
    const url = 'https://gateway.digitalpost.dk/apis/v1/mailboxes/';
    expect(isMailApiUrl(url)).toBe(true);
    expect(() => assertMailRead('GET', url)).not.toThrow();
  });

  test('rejects PATCH, POST, and DELETE before any fetch', async () => {
    const url = 'https://gateway.digitalpost.dk/apis/v1/mailboxes/mb/messages/id';
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return new Response('nope');
    };
    for (const method of ['PATCH', 'POST', 'DELETE', 'PUT']) {
      await expect(guardedMailFetch(fetchImpl, method, url)).rejects.toBeInstanceOf(ReadOnlyError);
    }
    expect(called).toBe(false);
  });

  test('does not treat the token host as the mail API', () => {
    expect(isMailApiUrl('https://digitalpost.dk/auth/oauth/token')).toBe(false);
  });

  test('the shared HTTP client refuses a mail-API write before fetch', async () => {
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('no');
    }) as unknown as typeof fetch;
    try {
      await expect(
        new HttpClient().request('https://gateway.digitalpost.dk/apis/v1/mailboxes/x/messages/y', {
          method: 'POST',
        }),
      ).rejects.toThrow(/Refusing/);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('the mail client source has no mutating HTTP method', () => {
    const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/method:\s*['"](?!GET)/);
    expect(source).not.toMatch(/\b(patch|delete|put)\s*\(/i);
  });
});
