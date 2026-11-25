import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DigitalPostPaths,
  EboksDeviceStore,
  generateEboksDevice,
  RateLimitedError,
  TokenStore,
  UpstreamChangedError,
} from '@digitalpost/client';
import { DigitalPostContext } from './context.ts';
import { runEboksExtractText, runEboksGetDocument } from './eboks-tools.ts';
import { toolFailure } from './tool-error.ts';
import { runDigest, runExtractDates, runMailboxSummary, runSearch, runStatus } from './tools.ts';

describe('tool handlers', () => {
  test('status, search, digest, dates, and summary stay on GET and hide tokens', async () => {
    const paths = await tempPaths();
    const store = new TokenStore({ paths, env: {} });
    await store.save({
      version: 1,
      status: 'ok',
      username: 'user',
      savedAt: 10,
      lastRenewAt: 10,
      tokens: {
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        expiresAt: Date.now() + 60 * 60_000,
        tokenType: 'Bearer',
      },
    });
    const calls: Array<{ method: string; url: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      const path = new URL(target).pathname;
      calls.push({ method: init?.method ?? 'GET', url: target });
      if (path.endsWith('/mailboxes/')) {
        return Response.json({
          mailboxes: [{ id: 'mb-citizen', ownerType: 'CITIZEN', ownerName: 'Test' }],
        });
      }
      if (path.includes('/folders/')) {
        return Response.json({
          folders: [{ id: 'inbox', name: 'Indbakke', folderType: 'INBOX' }],
        });
      }
      if (path.endsWith('/messages/msg-1')) {
        return Response.json({
          id: 'msg-1',
          label: 'Indkaldelse den 4. maj 2026 kl. 08:15 på Rigshospitalet',
          receivedDateTime: '2026-03-02T09:00:00Z',
          read: false,
          sender: { label: 'Hospitalet' },
          documents: [
            {
              id: 'doc-1',
              files: [{ id: 'file-1', filename: 'brev.pdf', encodingFormat: 'application/pdf' }],
            },
          ],
        });
      }
      if (path.endsWith('/content')) {
        const bytes = await Bun.file(
          new URL('../../digitalpost/fixtures/hello.pdf', import.meta.url),
        ).bytes();
        return new Response(bytes, { headers: { 'content-type': 'application/pdf' } });
      }
      return Response.json({
        messages: [
          {
            id: 'msg-1',
            mailboxId: 'mb-citizen',
            label: 'Indkaldelse den 4. maj 2026 kl. 08:15 på Rigshospitalet',
            receivedDateTime: '2026-03-02T09:00:00Z',
            read: false,
            sender: { label: 'Hospitalet' },
            documents: [
              {
                id: 'doc-1',
                files: [{ id: 'file-1', filename: 'brev.pdf', encodingFormat: 'application/pdf' }],
              },
            ],
          },
        ],
        totalElements: 1,
        totalPages: 1,
      });
    }) as unknown as typeof fetch;
    try {
      const context = new DigitalPostContext({ paths });
      const status = await runStatus(context);
      expect(JSON.stringify(status)).not.toContain('access-secret');
      expect(JSON.stringify(status)).not.toContain('refresh-secret');
      expect(status).toEqual(expect.objectContaining({ loggedIn: true, status: 'ok' }));

      const found = (await runSearch(context, { subject: 'Indkaldelse', limit: 5 })) as {
        messages: Array<{ id: string }>;
      };
      expect(found.messages.map((message) => message.id)).toEqual(['msg-1']);

      const digest = (await runDigest(context, {
        since: '2026-03-01T00:00:00Z',
        includePdf: false,
      })) as {
        mailboxes: Array<{ messages: Array<{ unread: boolean; detectedDates: unknown[] }> }>;
      };
      expect(digest.mailboxes[0]?.messages[0]?.unread).toBe(true);
      expect(digest.mailboxes[0]?.messages[0]?.detectedDates.length).toBeGreaterThan(0);

      const dates = (await runExtractDates(context, { messageId: 'msg-1', includePdf: true })) as {
        pdfTextUsed: boolean;
        dates: Array<{ date: string }>;
      };
      expect(dates.pdfTextUsed).toBe(true);
      expect(dates.dates.some((date) => date.date === '2026-05-04')).toBe(true);

      const summary = (await runMailboxSummary(context)) as {
        folders: unknown[];
        senders: unknown[];
      };
      expect(summary.folders.length).toBeGreaterThan(0);
      expect(summary.senders.length).toBeGreaterThan(0);

      expect(calls.every((call) => call.method === 'GET')).toBe(true);
      expect(calls.every((call) => call.url.startsWith('https://gateway.digitalpost.dk/'))).toBe(
        true,
      );
      expect(calls.some((call) => call.url.includes('e-boks.com'))).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('error results use the typed status and do not echo upstream bodies', () => {
    const limited = toolFailure(new RateLimitedError('Digital Post', '/mailboxes/'));
    expect(JSON.parse(limited.content[0]?.text ?? '')).toEqual(
      expect.objectContaining({ status: 'rate_limited' }),
    );
    const changed = toolFailure(new UpstreamChangedError('/messages/'));
    const body = JSON.parse(changed.content[0]?.text ?? '') as { status: string; message: string };
    expect(body.status).toBe('upstream_changed');
    expect(body.message).not.toContain('{');
  });

  test('e-Boks content tools fetch one letter and say it was marked read', async () => {
    const paths = await tempPaths();
    const store = new TokenStore({ paths, env: {} });
    await store.save({
      version: 1,
      status: 'ok',
      username: 'user',
      savedAt: 1,
      tokens: {
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        expiresAt: Date.now() + 60 * 60_000,
        tokenType: 'Bearer',
      },
    });
    await new EboksDeviceStore(paths).save({
      ...generateEboksDevice(),
      activated: true,
      name: 'Test',
    });
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      calls.push(`${init?.method ?? 'GET'} ${target}`);
      if (target.includes('usertoken')) return Response.json({ userToken: 'user-tok' });
      if (target.includes('oauth-dk.e-boks.com')) {
        return Response.json({ access_token: 'eboks-access', expires_in: 300 });
      }
      if (target.endsWith('/content')) {
        return new Response('Kære borger. Møde den 9. juni 2026 kl. 11:00.', {
          headers: { 'content-type': 'text/plain' },
        });
      }
      return Response.json({
        id: 'msg-9',
        subject: 'Fra banken',
        attachments: [{ id: 'a1', name: 'note.txt' }],
        content: { fileExtension: 'txt', mimeType: 'text/plain' },
      });
    }) as unknown as typeof fetch;
    try {
      const context = new DigitalPostContext({ paths });
      const saved = (await runEboksGetDocument(context, {
        folderId: 'inbox',
        messageId: 'msg-9',
      })) as { markedRead: boolean; warning: string; path: string };
      expect(saved.markedRead).toBe(true);
      expect(saved.warning).toContain('marks this letter read');
      const text = (await runEboksExtractText(context, {
        path: saved.path,
      })) as { markedRead: boolean; text: string };
      expect(text.markedRead).toBe(false);
      expect(text.text).toContain('9. juni 2026');
      const live = (await runEboksExtractText(context, {
        folderId: 'inbox',
        messageId: 'msg-9',
      })) as { markedRead: boolean; text: string };
      expect(live.markedRead).toBe(true);
      expect(live.text).toContain('juni 2026');
      const mail = calls.filter((call) => call.includes('/2/mail'));
      expect(mail.every((call) => call.startsWith('GET '))).toBe(true);
      expect(mail.filter((call) => call.includes('/content'))).toHaveLength(2);
      expect(mail.some((call) => /POST|PUT|PATCH|DELETE/.test(call.split(' ')[0] ?? ''))).toBe(
        false,
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

async function tempPaths(): Promise<DigitalPostPaths> {
  const dir = await mkdtemp(join(tmpdir(), 'digitalpost-handlers-'));
  await chmod(dir, 0o700);
  return {
    dir,
    tokenFile: join(dir, 'tokens.enc'),
    keyFile: join(dir, '.key'),
    deviceIdFile: join(dir, 'device-id'),
    downloadDir: join(dir, 'downloads'),
  };
}
