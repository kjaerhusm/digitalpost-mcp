import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '@digitalpost/client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DigitalPostContext } from './context.ts';
import { EBOKS_TOOL_NAMES, MARKS_READ_TOOL_NAMES } from './eboks-tools.ts';
import { createMcpApp } from './setup.ts';
import { discover, pageSizeArg, registerTools, TOOL_NAMES, toolNamesFor } from './tools.ts';

describe('tool list', () => {
  test('e-Boks tools are absent unless the flag is set', () => {
    expect(toolNamesFor({}).some((name) => name.startsWith('eboks.'))).toBe(false);
    expect(toolNamesFor({ DIGITALPOST_EBOKS: '1' })).toEqual([...TOOL_NAMES, ...EBOKS_TOOL_NAMES]);
    const without = recordTools({});
    const withFlag = recordTools({ DIGITALPOST_EBOKS: '1' });
    expect(without.some((tool) => tool.name.startsWith('eboks.'))).toBe(false);
    expect(
      withFlag.filter((tool) => tool.name.startsWith('eboks.')).map((tool) => tool.name),
    ).toEqual([...EBOKS_TOOL_NAMES]);
  });

  test('limit is the page size when size is omitted', () => {
    expect(pageSizeArg({ limit: 5 })).toEqual({ size: 5 });
    expect(pageSizeArg({ size: 8, limit: 5 })).toEqual({ size: 8 });
    expect(pageSizeArg({})).toEqual({});
  });

  test('only the two e-Boks content tools may mark a letter read', () => {
    const registered = recordTools({ DIGITALPOST_EBOKS: '1' });
    expect(
      registered.filter((tool) => tool.name.startsWith('eboks.')).map((tool) => tool.name),
    ).toEqual([...EBOKS_TOOL_NAMES]);
    const marking = registered
      .filter((tool) => tool.readOnlyHint !== true)
      .map((tool) => tool.name);
    expect(marking).toEqual([...MARKS_READ_TOOL_NAMES]);
    for (const tool of registered) {
      if (MARKS_READ_TOOL_NAMES.includes(tool.name as (typeof MARKS_READ_TOOL_NAMES)[number])) {
        expect(tool.readOnlyHint).toBe(false);
        expect(tool.destructiveHint).toBe(false);
      } else {
        expect(tool.readOnlyHint).toBe(true);
      }
    }
    const source = readFileSync(new URL('./eboks-tools.ts', import.meta.url), 'utf8');
    expect(source).toContain('markedRead: true');
    expect(source).toContain('EBOKS_CONTENT_WARNING');
    expect(source).not.toMatch(/POST|PUT|PATCH|DELETE/);
  });

  test('registers only the read-only Digital Post tools', () => {
    expect([...TOOL_NAMES]).toEqual([
      'digitalpost.discover',
      'digitalpost.list_folders',
      'digitalpost.list_messages',
      'digitalpost.search_messages',
      'digitalpost.get_message',
      'digitalpost.get_document',
      'digitalpost.extract_pdf_text',
      'digitalpost.list_new_since',
      'digitalpost.digest',
      'digitalpost.extract_dates',
      'digitalpost.status',
      'digitalpost.mailbox_summary',
    ]);
    for (const name of TOOL_NAMES) {
      expect(name).not.toMatch(/send|delete|move|mark|patch|reply|forward/i);
    }
    for (const tool of recordTools({})) {
      expect(tool.readOnlyHint).toBe(true);
      expect(tool.name.startsWith('eboks.')).toBe(false);
    }
  });

  test('discover reports login_required without calling the mail API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'digitalpost-tools-'));
    await chmod(dir, 0o700);
    const paths = {
      dir,
      tokenFile: join(dir, 'tokens.enc'),
      keyFile: join(dir, '.key'),
      deviceIdFile: join(dir, 'device-id'),
      downloadDir: join(dir, 'downloads'),
    };
    const store = new TokenStore({ paths, env: {} });
    await store.markLoginRequired(null);
    let fetched = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response('no', { status: 500 });
    }) as unknown as typeof fetch;
    try {
      const context = new DigitalPostContext({ paths });
      const result = await discover(context);
      expect(result.loggedIn).toBe(false);
      expect(result.status).toBe('login_required');
      expect(result.mailboxes).toEqual([]);
      const app = createMcpApp({ context });
      expect(app.mcp).toBeDefined();
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

function recordTools(env: NodeJS.ProcessEnv): Array<{
  name: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}> {
  const names: Array<{ name: string; readOnlyHint?: boolean; destructiveHint?: boolean }> = [];
  const server = {
    registerTool(
      name: string,
      config: { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } },
    ) {
      names.push({
        name,
        ...(config.annotations?.readOnlyHint !== undefined
          ? { readOnlyHint: config.annotations.readOnlyHint }
          : {}),
        ...(config.annotations?.destructiveHint !== undefined
          ? { destructiveHint: config.annotations.destructiveHint }
          : {}),
      });
    },
  } as unknown as McpServer;
  const dir = join(tmpdir(), 'digitalpost-tools-record');
  registerTools(
    server,
    new DigitalPostContext({
      paths: {
        dir,
        tokenFile: join(dir, 'tokens.enc'),
        keyFile: join(dir, '.key'),
        deviceIdFile: join(dir, 'device-id'),
        downloadDir: join(dir, 'downloads'),
      },
    }),
    env,
  );
  return names;
}
