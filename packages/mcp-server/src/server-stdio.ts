/**
 * MCP server on stdio. stdout is the JSON-RPC channel. Logs go to stderr.
 */

import { envFlag } from '@digitalpost/client';
import { silentLogger, stderrLogger } from '@digitalpost/mitid';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpApp } from './setup.ts';

const logger = envFlag('DIGITALPOST_LOG') ? stderrLogger('digitalpost-mcp') : silentLogger;
const { mcp } = createMcpApp({ logger });

export async function startStdioServer(): Promise<void> {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('digitalpost.shutdown', { signal });
    void mcp.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await mcp.connect(new StdioServerTransport());
  logger.info('digitalpost.stdio_ready');
}

if (import.meta.main) await startStdioServer();
