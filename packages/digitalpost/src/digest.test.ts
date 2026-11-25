import { describe, expect, test } from 'bun:test';
import type { DigitalPostApi, MessagePage } from './api.ts';
import { buildDigest, LIST_NEW_SINCE_MAX_PAGES, listNewSince } from './digest.ts';
import type { PublicMessage } from './redact.ts';
import { compareInstants } from './time.ts';

describe('timestamps', () => {
  test('compares instants rather than strings', () => {
    const earlier = '2026-03-02T09:30:00+02:00';
    const later = '2026-03-02T08:00:00Z';
    expect(earlier > later).toBe(true);
    expect(compareInstants(earlier, later)).toBeLessThan(0);
  });
});

describe('listNewSince', () => {
  test('keeps paging when a local unread filter empties a full page', async () => {
    const calls: number[] = [];
    const api = {
      async listMessages(_mailboxId: string, input: { page?: number }): Promise<MessagePage> {
        const page = input.page ?? 0;
        calls.push(page);
        if (page === 0) {
          return pageOf({
            messages: [],
            rawCount: 100,
            oldestReceivedAt: '2026-03-02T12:00:00Z',
            totalPages: 2,
          });
        }
        return pageOf({
          messages: [
            {
              id: 'unread-1',
              mailboxId: 'mb',
              folderId: null,
              subject: 'Later',
              sender: 'Skat',
              receivedAt: '2026-03-02T11:00:00Z',
              read: false,
              replyBy: null,
              legallyNotified: null,
              documents: [],
            },
          ],
          rawCount: 1,
          oldestReceivedAt: '2026-03-02T11:00:00Z',
          totalPages: 2,
        });
      },
    };
    const messages = await listNewSince(api as unknown as DigitalPostApi, ['mb'], {
      since: '2026-03-01T00:00:00Z',
      unread: true,
    });
    expect(calls).toEqual([0, 1]);
    expect(messages.map((message) => message.id)).toEqual(['unread-1']);
  });

  test('groups letters and reads PDF text only when asked', async () => {
    const pdfCalls: string[] = [];
    const api = {
      async listMessages(): Promise<MessagePage> {
        return pageOf({
          messages: [
            sample('mb-a', 'Indkaldelse den 4. maj 2026 kl. 08:15 på Aarhus Universitetshospital'),
          ],
          rawCount: 1,
          oldestReceivedAt: '2026-03-02T11:00:00Z',
          totalPages: 1,
        });
      },
      async getFileContent(): Promise<{ bytes: Uint8Array; contentType: string | null }> {
        pdfCalls.push('pdf');
        return { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), contentType: 'application/pdf' };
      },
    };
    const skipped = await buildDigest(
      api as unknown as DigitalPostApi,
      [{ id: 'mb-a', ownerName: 'Test' }],
      {
        since: '2026-03-01T00:00:00Z',
        includePdf: false,
      },
    );
    expect(pdfCalls).toEqual([]);
    expect(skipped.mailboxes[0]?.messages[0]?.detectedDates[0]).toEqual(
      expect.objectContaining({
        kind: 'appointment',
        date: '2026-05-04',
        time: '08:15',
        place: 'Aarhus Universitetshospital',
        heuristic: true,
      }),
    );
    expect(skipped.note).toContain('heuristic');
    expect(skipped.heuristic).toBe(true);
  });

  test('scans three pages per mailbox unless a capped maxPages is set', async () => {
    let calls = 0;
    const api = {
      async listMessages(): Promise<MessagePage> {
        calls += 1;
        return pageOf({
          messages: [],
          rawCount: 100,
          oldestReceivedAt: '2026-06-01T00:00:00Z',
          totalPages: 40,
        });
      },
    };
    await listNewSince(api as unknown as DigitalPostApi, ['mb'], { since: '2026-01-01T00:00:00Z' });
    expect(calls).toBe(3);
    calls = 0;
    await listNewSince(api as unknown as DigitalPostApi, ['mb'], {
      since: '2026-01-01T00:00:00Z',
      maxPages: 1,
    });
    expect(calls).toBe(1);
    calls = 0;
    await listNewSince(api as unknown as DigitalPostApi, ['mb'], {
      since: '2026-01-01T00:00:00Z',
      maxPages: 100,
    });
    expect(calls).toBe(LIST_NEW_SINCE_MAX_PAGES);
  });
});

function sample(mailboxId: string, subject: string): PublicMessage {
  return {
    id: 'msg-a',
    mailboxId,
    folderId: null,
    subject,
    sender: 'Regionen',
    receivedAt: '2026-03-02T11:00:00Z',
    read: false,
    replyBy: null,
    legallyNotified: null,
    documents: [],
  };
}

function pageOf(
  partial: Pick<MessagePage, 'messages' | 'rawCount' | 'oldestReceivedAt' | 'totalPages'>,
): MessagePage {
  return {
    page: 0,
    size: 100,
    totalElements: null,
    clientFiltered: partial.messages.length !== partial.rawCount,
    ...partial,
  };
}
