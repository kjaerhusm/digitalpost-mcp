import { readFile } from 'node:fs/promises';
import {
  assertInsideDownloadDir,
  ContentFetchedError,
  DigitalPostError,
  EBOKS_CONTENT_WARNING,
  EboksApi,
  EboksDeviceStore,
  extractPdfText,
  writeDownload,
} from '@digitalpost/client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DigitalPostContext } from './context.ts';
import { jsonResult, toolFailure } from './tool-error.ts';

export const EBOKS_TOOL_NAMES = [
  'eboks.discover',
  'eboks.list_folders',
  'eboks.list_messages',
  'eboks.get_message',
  'eboks.get_document',
  'eboks.extract_pdf_text',
] as const;

/** The only tools that download e-Boks bytes. Doing so marks that one letter read. */
export const MARKS_READ_TOOL_NAMES = ['eboks.get_document', 'eboks.extract_pdf_text'] as const;

const CONTENT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

async function guarded(action: () => Promise<unknown>): Promise<ReturnType<typeof jsonResult>> {
  try {
    return jsonResult(await action());
  } catch (error) {
    return toolFailure(error);
  }
}

async function api(context: DigitalPostContext): Promise<EboksApi> {
  const device = await new EboksDeviceStore(context.paths).load();
  if (!device?.activated) {
    throw new DigitalPostError('e-Boks is not registered. Run `digitalpost eboks-register`.');
  }
  return new EboksApi({
    digitalPostAccessToken: () => context.session.accessToken(),
    device,
  });
}

export function registerEboksTools(server: McpServer, context: DigitalPostContext): void {
  const userId = z
    .string()
    .min(1)
    .optional()
    .describe('Shared mailbox userId from eboks.discover. Omit for your own mailbox.');
  const folderId = z.string().min(1).describe('Folder id from eboks.list_folders.');
  const messageId = z.string().min(1).describe('One message id. This tool never accepts a list.');

  server.registerTool(
    'eboks.discover',
    {
      title: 'e-Boks status',
      description:
        'Whether an e-Boks device is registered, the profile name, folders, and shared mailboxes. Does not mark mail read. Does not return a CPR. Prefer this before any content tool.',
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const client = await api(context);
        const [profile, folders, shares] = await Promise.all([
          client.profile(),
          client.listFolders(),
          client.shares(),
        ]);
        return { ...profile, folders, shares };
      }),
  );

  server.registerTool(
    'eboks.list_folders',
    {
      title: 'e-Boks folders',
      description: 'Folders in your e-Boks mailbox or a shared one. Does not mark mail read.',
      annotations: { readOnlyHint: true },
      inputSchema: { userId },
    },
    async (args) =>
      guarded(async () => {
        const client = await api(context);
        return { folders: await client.listFolders(args.userId) };
      }),
  );

  server.registerTool(
    'eboks.list_messages',
    {
      title: 'e-Boks messages',
      description:
        'One page of e-Boks message metadata. Does not mark them read. offset is the first row; limit is the page size (default 20, max 100). Prefer this over downloading content.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        folderId,
        userId,
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async (args) =>
      guarded(async () => {
        const client = await api(context);
        return client.listMessages(args.folderId, {
          ...(args.userId ? { userId: args.userId } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
      }),
  );

  server.registerTool(
    'eboks.get_message',
    {
      title: 'e-Boks message',
      description:
        'Metadata for one e-Boks message, including attachment names. Does not mark it read. Use this before eboks.get_document.',
      annotations: { readOnlyHint: true },
      inputSchema: { folderId, messageId, userId },
    },
    async (args) =>
      guarded(async () => {
        const client = await api(context);
        return client.getMessage(args.folderId, args.messageId, args.userId);
      }),
  );

  server.registerTool(
    'eboks.get_document',
    {
      title: 'Download one e-Boks file',
      description:
        'Download one e-Boks letter or one attachment into the local download directory. ' +
        'Calling this marks that letter read in e-Boks. It fetches only the message you name, never a folder. ' +
        `${EBOKS_CONTENT_WARNING}`,
      annotations: CONTENT_ANNOTATIONS,
      inputSchema: {
        folderId,
        messageId,
        attachmentId: z
          .string()
          .min(1)
          .optional()
          .describe('Attachment id from eboks.get_message. Omit to download the letter body.'),
        userId,
        filename: z
          .string()
          .optional()
          .describe('Suggested filename. Unsafe characters are stripped.'),
      },
    },
    async (args) => guarded(() => runEboksGetDocument(context, args)),
  );

  server.registerTool(
    'eboks.extract_pdf_text',
    {
      title: 'Text of one e-Boks letter',
      description:
        'Text of one e-Boks letter or attachment. Fetching it from e-Boks marks that letter read. ' +
        'A local path does not contact e-Boks. This fetches only the message you name. ' +
        `${EBOKS_CONTENT_WARNING}`,
      annotations: CONTENT_ANNOTATIONS,
      inputSchema: {
        folderId: folderId.optional(),
        messageId: messageId.optional(),
        attachmentId: z.string().min(1).optional(),
        userId,
        path: z
          .string()
          .optional()
          .describe('Existing file inside the download directory. When set, e-Boks is not called.'),
      },
    },
    async (args) => guarded(() => runEboksExtractText(context, args)),
  );
}

export async function runEboksGetDocument(
  context: DigitalPostContext,
  args: {
    folderId: string;
    messageId: string;
    attachmentId?: string | undefined;
    userId?: string | undefined;
    filename?: string | undefined;
  },
): Promise<unknown> {
  const client = await api(context);
  const message = await client.getMessage(args.folderId, args.messageId, args.userId);
  const attachment = args.attachmentId
    ? message.attachments.find((item) => item.id === args.attachmentId)
    : null;
  const downloaded = args.attachmentId
    ? await client.getAttachmentContent(
        args.folderId,
        args.messageId,
        args.attachmentId,
        args.userId,
      )
    : await client.getMessageContent(args.folderId, args.messageId, args.userId);
  const filename =
    args.filename ||
    attachment?.filename ||
    message.bodyFile?.filename ||
    (args.attachmentId ? 'attachment.bin' : 'letter.bin');
  try {
    const path = await writeDownload(context.paths.downloadDir, downloaded.bytes, filename);
    return {
      path,
      bytes: downloaded.bytes.byteLength,
      mimeType: attachment?.mimeType ?? message.bodyFile?.mimeType ?? downloaded.contentType,
      filename,
      markedRead: true,
      warning: EBOKS_CONTENT_WARNING,
    };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Could not save the file.';
    throw new ContentFetchedError(`${messageText} ${EBOKS_CONTENT_WARNING}`);
  }
}

export async function runEboksExtractText(
  context: DigitalPostContext,
  args: {
    folderId?: string | undefined;
    messageId?: string | undefined;
    attachmentId?: string | undefined;
    userId?: string | undefined;
    path?: string | undefined;
  },
): Promise<unknown> {
  if (args.path) {
    const bytes = new Uint8Array(
      await readFile(await assertInsideDownloadDir(context.paths.downloadDir, args.path)),
    );
    const text = await textFromBytes(bytes, null);
    return {
      ...text,
      markedRead: false,
      warning: 'Read from a file already on disk. This call did not contact e-Boks.',
    };
  }
  if (!args.folderId || !args.messageId) {
    throw new DigitalPostError('Provide path, or folderId and messageId.');
  }
  const client = await api(context);
  const downloaded = args.attachmentId
    ? await client.getAttachmentContent(
        args.folderId,
        args.messageId,
        args.attachmentId,
        args.userId,
      )
    : await client.getMessageContent(args.folderId, args.messageId, args.userId);
  try {
    const text = await textFromBytes(downloaded.bytes, downloaded.contentType);
    return { ...text, markedRead: true, warning: EBOKS_CONTENT_WARNING };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Could not read the letter.';
    throw new ContentFetchedError(`${messageText} ${EBOKS_CONTENT_WARNING}`);
  }
}

async function textFromBytes(
  bytes: Uint8Array,
  contentType: string | null,
): Promise<{ text: string; truncated: boolean; pages: number; format: 'pdf' | 'text' }> {
  const head = new TextDecoder().decode(bytes.subarray(0, 5));
  if (head.startsWith('%PDF')) {
    const extracted = await extractPdfText(bytes);
    return { ...extracted, format: 'pdf' };
  }
  const type = contentType?.toLowerCase() ?? '';
  if (
    type.startsWith('text/') ||
    type.includes('json') ||
    type.includes('xml') ||
    looksTextual(bytes)
  ) {
    const text = new TextDecoder().decode(bytes).trim();
    const truncated = text.length > 100_000;
    return { text: truncated ? text.slice(0, 100_000) : text, truncated, pages: 0, format: 'text' };
  }
  throw new DigitalPostError('That file is not a PDF or text, so there is nothing to extract.');
}

function looksTextual(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 200));
  if (sample.length === 0) return false;
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable += 1;
  }
  return printable / sample.length > 0.9;
}
