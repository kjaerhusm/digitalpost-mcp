import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildMessageQuery, containsQuery, DigitalPostApi } from './api.ts';
import { RateLimitedError, UpstreamChangedError } from './errors.ts';
import { toPublicMessage } from './redact.ts';

const mailboxes = JSON.parse(
  readFileSync(new URL('../fixtures/mailboxes.json', import.meta.url), 'utf8'),
) as {
  mailboxes: Array<Record<string, unknown>>;
};
const messages = JSON.parse(
  readFileSync(new URL('../fixtures/messages.json', import.meta.url), 'utf8'),
) as {
  messages: Array<Record<string, unknown>>;
};

describe('message query builder', () => {
  test('sends folder, date, search, and sender as query parameters', () => {
    const query = buildMessageQuery({
      page: 1,
      size: 50,
      folderId: 'folder-inbox',
      since: '2026-03-01T12:00:00Z',
      search: 'skat',
      sender: 'Skatteforvaltningen',
    });
    expect(query.get('page')).toBe('1');
    expect(query.get('size')).toBe('50');
    expect(query.get('folderId')).toBe('folder-inbox');
    expect(query.get('receivedDateFrom')).toBe('2026-03-01');
    expect(query.get('any')).toBe('skat');
    expect(query.get('sender.label')).toBe('Skatteforvaltningen');
    expect(query.get('sortFields')).toBe('receivedDateTime:desc');
  });

  test('sends a received-to date and a subject contains query', () => {
    const query = buildMessageQuery({
      page: 0,
      size: 20,
      until: '2026-04-30T15:00:00Z',
      subject: 'indkaldelse',
      sender: 'Region',
      senderWildcard: true,
    });
    expect(query.get('receivedDateTo')).toBe('2026-04-30');
    expect(query.get('label')).toBe(containsQuery('indkaldelse'));
    expect(query.get('sender.label')).toBe('*Region*');
  });
});

describe('DigitalPostApi', () => {
  test('issues only GET requests and strips identity numbers', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const api = new DigitalPostApi({
      accessToken: async () => 'token-value',
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init?.method ?? 'GET' });
        const path = new URL(url).pathname;
        if (path.endsWith('/mailboxes/')) return json(mailboxes);
        if (path.endsWith('/messages/')) return json(messages);
        if (path.endsWith('/messages/msg-1')) return json(messages.messages[0] ?? {});
        if (path.endsWith('/content')) {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          });
        }
        return new Response('missing', { status: 404 });
      },
    });

    const boxes = await api.listMailboxes();
    expect(boxes[0]?.ownerName).toBe('Test Citizen');
    expect(JSON.stringify(boxes)).not.toContain('0000000000');

    const page = await api.listMessages('mb-citizen', {
      unread: true,
      since: '2026-02-01T00:00:00Z',
    });
    expect(page.messages.map((message) => message.id)).toEqual(['msg-1']);
    expect(page.clientFiltered).toBe(true);
    const rendered = JSON.stringify(page);
    expect(rendered).not.toContain('0000000000');
    expect(rendered).not.toContain('recipientId');
    expect(page.messages[0]?.sender).toBe('Skatteforvaltningen');
    expect(page.messages[0]?.documents[0]?.files[0]?.filename).toBe('skat.pdf');

    const one = await api.getMessage('mb-citizen', 'msg-1');
    expect(one.subject).toBe('Ejendomsskat 2026');
    expect(toPublicMessage(messages.messages[0] ?? {}).subject).toBe('Ejendomsskat 2026');

    const file = await api.getFileContent('mb-citizen', 'msg-1', 'doc-1', 'file-1');
    expect(file.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(page.rawCount).toBe(2);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.method).toBe('GET');
      expect(call.url).toContain('https://gateway.digitalpost.dk/apis/v1/');
      expect(call.url).not.toContain('token-value');
    }
  });

  test('retries once with a refreshed token after HTTP 401', async () => {
    const tokens = ['stale', 'fresh'];
    let reads = 0;
    const api = new DigitalPostApi({
      accessToken: async () => tokens[0] ?? 'stale',
      refreshAccessToken: async () => 'fresh',
      fetchImpl: async (_url, init) => {
        reads += 1;
        const header = new Headers(init?.headers).get('authorization') ?? '';
        if (header.includes('stale')) return new Response('no', { status: 401 });
        return json(mailboxes);
      },
    });
    const boxes = await api.listMailboxes();
    expect(boxes).toHaveLength(2);
    expect(reads).toBe(2);
    expect(tokens[1]).toBe('fresh');
  });

  test('retries 503 and timeouts, then reports rate_limited', async () => {
    const sleeps: number[] = [];
    let reads = 0;
    const flaky = new DigitalPostApi({
      accessToken: async () => 'token',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: async () => {
        reads += 1;
        if (reads === 1) throw new Error('timed out');
        if (reads === 2) return new Response('no', { status: 503 });
        return json(mailboxes);
      },
    });
    expect(await flaky.listMailboxes()).toHaveLength(2);
    expect(reads).toBe(3);
    expect(sleeps.length).toBe(2);

    let limited = 0;
    const blocked = new DigitalPostApi({
      accessToken: async () => 'token',
      sleep: async () => {},
      fetchImpl: async () => {
        limited += 1;
        return new Response('slow', { status: 429, headers: { 'retry-after': '1' } });
      },
    });
    await expect(blocked.listMailboxes()).rejects.toBeInstanceOf(RateLimitedError);
    expect(limited).toBe(4);
  });

  test('rejects a mailbox list that is not the expected shape', async () => {
    const secret = 'do-not-echo-this-body';
    const api = new DigitalPostApi({
      accessToken: async () => 'token',
      fetchImpl: async () => Response.json({ mailboxes: secret }),
    });
    await expect(api.listMailboxes()).rejects.toBeInstanceOf(UpstreamChangedError);
    try {
      await api.listMailboxes();
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
