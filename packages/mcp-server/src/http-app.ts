/**
 * Streamable HTTP MCP app. Binding and process startup live in server.ts so
 * importing this module does not read DIGITALPOST_MCP_HOST.
 */

import {
  DEFAULT_MCP_PORT,
  eboksEnabled,
  isLoopbackHost,
  isLoopbackOrigin,
  MAIL_READ_NOTE,
} from '@digitalpost/client';
import { type Logger, silentLogger } from '@digitalpost/mitid';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { DigitalPostContext } from './context.ts';
import { createMcpApp, type McpApp } from './setup.ts';
import { toolNamesFor } from './tools.ts';

const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_IDLE_MS = 30 * 60_000;

export interface HttpAppOptions {
  port?: number;
  maxSessions?: number;
  idleMs?: number;
  now?: () => number;
  logger?: Logger;
  context?: DigitalPostContext;
}

interface HttpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  app: McpApp;
  lastActivityAt: number;
}

export function createHttpApp(options: HttpAppOptions = {}): Hono {
  const port = options.port ?? DEFAULT_MCP_PORT;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? silentLogger;
  const context = options.context ?? new DigitalPostContext({ logger });
  const sessions = new Map<string, HttpSession>();
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  const allowedOrigins = allowedHosts.map((host) => `http://${host}`);

  const app = new Hono();

  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (!isLoopbackHost(host)) return c.text('Forbidden', 403);
    const origin = c.req.header('origin');
    if (origin && !isLoopbackOrigin(origin)) return c.text('Forbidden', 403);
    await next();
  });

  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      name: 'digitalpost-mcp',
      readOnly: !eboksEnabled(),
      note: MAIL_READ_NOTE,
      tools: [...toolNamesFor()],
    }),
  );
  app.post('/mcp', (c) => handleMcp(c.req.raw));
  app.get('/mcp', (c) => handleMcp(c.req.raw));
  app.delete('/mcp', (c) => handleMcp(c.req.raw));
  return app;

  async function handleMcp(request: Request): Promise<Response> {
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId) {
      evictIdle();
      const session = sessions.get(sessionId);
      if (!session) {
        return Response.json(
          { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null },
          { status: 404 },
        );
      }
      session.lastActivityAt = now();
      return session.transport.handleRequest(request);
    }

    evictIdle();
    await dropOldestUntil(maxSessions - 1);

    let created: string | undefined;
    const sessionApp = createMcpApp({ logger, context });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => crypto.randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts,
      allowedOrigins,
      onsessioninitialized: (id) => {
        created = id;
        sessions.set(id, { transport, app: sessionApp, lastActivityAt: now() });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    await sessionApp.mcp.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      if (!created) await closeQuiet(transport, sessionApp);
      return response;
    } catch (error) {
      if (!created) await closeQuiet(transport, sessionApp);
      throw error;
    }
  }

  function evictIdle(): void {
    const current = now();
    for (const [id, session] of sessions) {
      if (current - session.lastActivityAt > idleMs) {
        sessions.delete(id);
        void closeQuiet(session.transport, session.app);
      }
    }
  }

  async function dropOldestUntil(limit: number): Promise<void> {
    while (sessions.size > limit) {
      let oldestId: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, session] of sessions) {
        if (session.lastActivityAt < oldestAt) {
          oldestAt = session.lastActivityAt;
          oldestId = id;
        }
      }
      if (!oldestId) return;
      const session = sessions.get(oldestId);
      sessions.delete(oldestId);
      if (session) await closeQuiet(session.transport, session.app);
    }
  }
}

async function closeQuiet(
  transport: WebStandardStreamableHTTPServerTransport,
  sessionApp: McpApp,
): Promise<void> {
  await transport.close().catch(() => undefined);
  await sessionApp.mcp.close().catch(() => undefined);
}
