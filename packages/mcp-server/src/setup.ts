import { eboksEnabled } from '@digitalpost/client';
import type { Logger } from '@digitalpost/mitid';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DigitalPostContext } from './context.ts';
import { registerTools } from './tools.ts';
import { VERSION } from './version.ts';

const INSTRUCTIONS = [
  'Read-only access to the signed-in person\'s Danish Digital Post ("offentlig post" / post from public authorities).',
  'The letters live in the state mailbox shown by mit.dk, e-Boks, and borger.dk.',
  '',
  'Call digitalpost.discover first. If loggedIn is false, stop and tell the user to run `digitalpost login`.',
  'Then list_folders, list_messages, or search_messages. get_message is one letter. get_document saves a file. extract_pdf_text reads a PDF. extract_dates finds appointment and deadline hints.',
  'digitalpost.digest groups new letters by mailbox. digitalpost.status reports login health without secrets.',
  '',
  'Digital Post GET requests do not mark letters read. You cannot move, delete, or send Digital Post.',
  'Do not ask the user for a CPR number. Do not print tokens.',
  "Reply in the user's language. Dates can stay ISO unless they ask otherwise.",
  ...(eboksEnabled()
    ? [
        '',
        'e-Boks metadata tools are enabled. Prefer eboks.get_message. eboks.get_document and eboks.extract_pdf_text download one letter and e-Boks marks that letter read.',
        'Do not download e-Boks mail in bulk. There is no delete, move, or mark-unread tool.',
      ]
    : []),
].join('\n');

export interface McpApp {
  mcp: McpServer;
  context: DigitalPostContext;
}

export function createMcpApp(options?: { logger?: Logger; context?: DigitalPostContext }): McpApp {
  const context =
    options?.context ?? new DigitalPostContext(options?.logger ? { logger: options.logger } : {});
  const mcp = new McpServer(
    { name: 'digitalpost-mcp', version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  registerTools(mcp, context);
  return { mcp, context };
}
