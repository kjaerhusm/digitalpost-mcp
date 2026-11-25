import { describe, expect, test } from 'bun:test';
import { EBOKS_API_BASE } from './constants.ts';
import { assertEboksMailRead, isEboksContentPath, isEboksMailUrl } from './eboks-guard.ts';
import { ReadOnlyError } from './errors.ts';
import { guardedFetch } from './guarded-fetch.ts';

describe('e-Boks mail guard', () => {
  test('allows GET against mail routes', () => {
    const url = `${EBOKS_API_BASE}/mail/folders`;
    expect(isEboksMailUrl(url)).toBe(true);
    expect(() => assertEboksMailRead('GET', url)).not.toThrow();
    expect(() =>
      assertEboksMailRead('GET', `${EBOKS_API_BASE}/mail/folders/1/messages/2`),
    ).not.toThrow();
  });

  test('allows GET of one message or one attachment and rejects every other content path', async () => {
    const message = `${EBOKS_API_BASE}/mail/folders/1/messages/2/content`;
    const attachment = `${EBOKS_API_BASE}/mail/folders/1/messages/2/attachment/3/content`;
    const allowed = [
      message,
      `${message}?userId=share-1`,
      `${message}/`,
      attachment,
      message.replace('/content', '%2Fcontent'),
      message.replace('/content', '/CONTENT'),
    ];
    for (const url of allowed) {
      expect(() => assertEboksMailRead('GET', url)).not.toThrow();
    }
    expect(isEboksContentPath('/2/mail/folders/1/messages/2/content')).toBe(true);
    expect(isEboksContentPath('/2/mail/folders/1/messages/2/attachment/3/content')).toBe(true);
    expect(isEboksContentPath('/2/mail/folders/1/content')).toBe(false);
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('no');
    }) as unknown as typeof fetch;
    try {
      for (const url of [
        `${EBOKS_API_BASE}/mail/content`,
        `${EBOKS_API_BASE}/mail/folders/1/content`,
        `${EBOKS_API_BASE}/mail/folders/1/messages/content`,
        `${EBOKS_API_BASE}/mail/folders/1/messages/2/content/extra`,
        `${EBOKS_API_BASE}/mail/folders/1/messages/2/attachments/3/content`,
        `${message}/other`,
      ]) {
        expect(() => assertEboksMailRead('GET', url)).toThrow(ReadOnlyError);
        await expect(guardedFetch(url, { method: 'GET' })).rejects.toBeInstanceOf(ReadOnlyError);
      }
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        await expect(guardedFetch(message, { method })).rejects.toBeInstanceOf(ReadOnlyError);
        await expect(guardedFetch(attachment, { method })).rejects.toBeInstanceOf(ReadOnlyError);
      }
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('does not treat Digital Post file content as e-Boks mail', () => {
    const url =
      'https://gateway.digitalpost.dk/apis/v1/mailboxes/mb/messages/id/documents/d/files/f/content';
    expect(isEboksMailUrl(url)).toBe(false);
    expect(() => assertEboksMailRead('GET', url)).not.toThrow();
  });

  test('rejects writes to mail routes before fetch', async () => {
    const url = `${EBOKS_API_BASE}/mail/folders/1/messages/2`;
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('no');
    }) as unknown as typeof fetch;
    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        await expect(guardedFetch(url, { method })).rejects.toBeInstanceOf(ReadOnlyError);
      }
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('does not treat device registration as mail', () => {
    expect(isEboksMailUrl(`${EBOKS_API_BASE}/user/current/device`)).toBe(false);
    expect(() => assertEboksMailRead('PUT', `${EBOKS_API_BASE}/user/current/device`)).not.toThrow();
  });
});
