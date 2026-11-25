/**
 * Process entry for the streamable HTTP server. Host and port are read here,
 * not at import time, so other commands can import the package.
 */

import { DEFAULT_MCP_PORT, envFlag, loopbackHost, startRenewLoop } from '@digitalpost/client';
import { consoleLogger, silentLogger } from '@digitalpost/mitid';
import { DigitalPostContext } from './context.ts';
import { createHttpApp } from './http-app.ts';

export function startHttpServer(options?: { withRenew?: boolean }): void {
  const host = loopbackHost(process.env.DIGITALPOST_MCP_HOST);
  const port = Number(process.env.DIGITALPOST_MCP_PORT ?? DEFAULT_MCP_PORT);
  const logger = envFlag('DIGITALPOST_LOG') ? consoleLogger('digitalpost-mcp') : silentLogger;
  const context = new DigitalPostContext({ logger });
  if (options?.withRenew) {
    startRenewLoop(context.session, {
      logger: {
        info: (event) => logger.info(event),
        warn: (event) => logger.warn(event),
      },
    });
  }
  const app = createHttpApp({ port, logger, context });
  Bun.serve({ hostname: host, port, fetch: app.fetch });
  logger.info('digitalpost.http_ready', { host, port, renew: Boolean(options?.withRenew) });
}

if (import.meta.main) startHttpServer();
