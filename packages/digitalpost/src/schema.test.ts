import { describe, expect, test } from 'bun:test';
import { UpstreamChangedError } from './errors.ts';
import { parseMailboxList, parseMessage, parseMessageList } from './schema.ts';

describe('response schema', () => {
  test('accepts a message list and ignores extra fields', () => {
    const parsed = parseMessageList(
      {
        messages: [{ id: 'msg-1', label: 'Skat', read: false, secret: '0000000000' }],
        totalElements: 1,
        totalPages: 1,
      },
      '/messages/',
    );
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.totalElements).toBe(1);
  });

  test('fails loudly without copying the body', () => {
    const secret = 'fixture-body-should-not-leak';
    expect(() => parseMessageList({ messages: secret }, '/messages/')).toThrow(
      UpstreamChangedError,
    );
    try {
      parseMailboxList({ mailboxes: [{ id: 1, note: secret }] }, '/mailboxes/');
      throw new Error('expected a schema error');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamChangedError);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain('1');
    }
    expect(() => parseMessage({ label: 'no id' }, '/messages/msg')).toThrow(UpstreamChangedError);
  });
});
