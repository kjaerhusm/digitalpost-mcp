import { describe, expect, test } from 'bun:test';
import type { DigitalPostApi, MessagePage } from './api.ts';
import type { PublicMessage } from './redact.ts';
import { searchMessages } from './search.ts';

describe('searchMessages', () => {
  test('filters attachments locally and stops at the limit with a cursor', async () => {
    const calls: Array<{ mailboxId: string; page?: number; sender?: string }> = [];
    const api = {
      async listMessages(
        mailboxId: string,
        input: { page?: number; sender?: string },
      ): Promise<MessagePage> {
        calls.push({
          mailboxId,
          ...(input.page !== undefined ? { page: input.page } : {}),
          ...(input.sender !== undefined ? { sender: input.sender } : {}),
        });
        if (mailboxId === 'mb-2') return pageOf([letter('d', true)]);
        return pageOf([letter('a', false), letter('b', true), letter('c', true)]);
      },
    };
    const first = await searchMessages(api as unknown as DigitalPostApi, {
      mailboxIds: ['mb-1', 'mb-2'],
      hasAttachments: true,
      limit: 2,
      sender: 'Skat',
    });
    expect(first.messages.map((message) => message.id)).toEqual(['b', 'c']);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(calls[0]?.sender).toBe('Skat');
    const second = await searchMessages(api as unknown as DigitalPostApi, {
      mailboxIds: [],
      cursor: first.nextCursor ?? '',
    });
    expect(second.messages.map((message) => message.id)).toEqual(['d']);
    expect(calls.some((call) => call.mailboxId === 'mb-2')).toBe(true);
  });
});

function letter(id: string, files: boolean): PublicMessage {
  return {
    id,
    mailboxId: null,
    folderId: null,
    subject: `Emne ${id}`,
    sender: 'Skatteforvaltningen',
    receivedAt: '2026-03-02T09:00:00Z',
    read: false,
    replyBy: null,
    legallyNotified: null,
    documents: files
      ? [
          {
            id: 'd',
            label: null,
            documentType: null,
            files: [{ id: 'f', filename: 'a.pdf', mimeType: 'application/pdf', size: 1 }],
          },
        ]
      : [],
  };
}

function pageOf(messages: PublicMessage[]): MessagePage {
  return {
    messages,
    page: 0,
    size: 100,
    rawCount: messages.length,
    oldestReceivedAt: messages.at(-1)?.receivedAt ?? null,
    totalElements: messages.length,
    totalPages: 1,
    clientFiltered: false,
  };
}
