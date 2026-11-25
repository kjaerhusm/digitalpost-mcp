import { describe, expect, test } from 'bun:test';
import { loopbackHost, MAIL_READ_NOTE } from '@digitalpost/client';
import { createHttpApp } from './http-app.ts';
import { startHttpServer } from './server.ts';
import { toolNamesFor } from './tools.ts';

const HOST = '127.0.0.1:8788';

function local(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has('host')) headers.set('host', HOST);
  return new Request(`http://127.0.0.1:8788${path}`, { ...init, headers });
}

function initializeBody(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  });
}

async function openSession(app: ReturnType<typeof createHttpApp>, id: number): Promise<string> {
  const response = await app.fetch(
    local('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: initializeBody(id),
    }),
  );
  expect(response.status).toBe(200);
  const sessionId = response.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('missing session id');
  return sessionId;
}

describe('HTTP server', () => {
  test('healthz lists the tools and does not require a login', async () => {
    const app = createHttpApp();
    const response = await app.fetch(local('/healthz'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      readOnly: boolean;
      note: string;
      tools: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.readOnly).toBe(true);
    expect(body.note).toBe(MAIL_READ_NOTE);
    expect(body.tools).toEqual([...toolNamesFor()]);
  });

  test('healthz is not read-only while e-Boks content tools are enabled', async () => {
    const previous = process.env.DIGITALPOST_EBOKS;
    process.env.DIGITALPOST_EBOKS = '1';
    try {
      const app = createHttpApp();
      const response = await app.fetch(local('/healthz'));
      const body = (await response.json()) as { readOnly: boolean; note: string; tools: string[] };
      expect(body.readOnly).toBe(false);
      expect(body.note).toBe(MAIL_READ_NOTE);
      expect(body.tools).toContain('eboks.get_document');
    } finally {
      if (previous === undefined) delete process.env.DIGITALPOST_EBOKS;
      else process.env.DIGITALPOST_EBOKS = previous;
    }
  });

  test('refuses a foreign Host and a foreign Origin', async () => {
    const app = createHttpApp();
    const host = await app.fetch(
      local('/mcp', {
        method: 'POST',
        headers: { host: 'evil.example', 'content-type': 'application/json' },
        body: initializeBody(1),
      }),
    );
    expect(host.status).toBe(403);
    const origin = await app.fetch(
      local('/mcp', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: initializeBody(1),
      }),
    );
    expect(origin.status).toBe(403);
  });

  test('the 17th session replaces the oldest instead of returning 503', async () => {
    const app = createHttpApp({ maxSessions: 16 });
    const ids: string[] = [];
    for (let i = 0; i < 17; i++) ids.push(await openSession(app, i + 1));
    const oldest = ids[0];
    if (!oldest) throw new Error('no session');
    const stale = await app.fetch(
      local('/mcp', {
        method: 'POST',
        headers: {
          'mcp-session-id': oldest,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 99 }),
      }),
    );
    expect(stale.status).toBe(404);
    const newest = ids[16];
    if (!newest) throw new Error('no newest session');
    const live = await app.fetch(
      local('/mcp', {
        method: 'POST',
        headers: {
          'mcp-session-id': newest,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 100 }),
      }),
    );
    expect(live.status).not.toBe(404);
    expect(live.status).not.toBe(503);
  });

  test('idle sessions are evicted', async () => {
    let clock = 0;
    const app = createHttpApp({ idleMs: 1_000, now: () => clock, maxSessions: 4 });
    const first = await openSession(app, 1);
    clock = 5_000;
    await openSession(app, 2);
    const stale = await app.fetch(
      local('/mcp', {
        method: 'POST',
        headers: {
          'mcp-session-id': first,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 3 }),
      }),
    );
    expect(stale.status).toBe(404);
  });

  test('refuses to bind a non-loopback host, and only when the server starts', () => {
    expect(loopbackHost(undefined)).toBe('127.0.0.1');
    expect(loopbackHost('localhost')).toBe('127.0.0.1');
    expect(() => loopbackHost('0.0.0.0')).toThrow(/127\.0\.0\.1/);
    const previous = process.env.DIGITALPOST_MCP_HOST;
    process.env.DIGITALPOST_MCP_HOST = '0.0.0.0';
    try {
      expect(() => startHttpServer()).toThrow(/127\.0\.0\.1/);
    } finally {
      if (previous === undefined) delete process.env.DIGITALPOST_MCP_HOST;
      else process.env.DIGITALPOST_MCP_HOST = previous;
    }
  });
});
