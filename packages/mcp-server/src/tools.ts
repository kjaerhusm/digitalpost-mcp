import { readFile } from 'node:fs/promises';
import {
  assertInsideDownloadDir,
  buildDigest,
  DATES_NOTE,
  DigitalPostError,
  datesFromLetter,
  decodeCursor,
  EboksDeviceStore,
  eboksEnabled,
  encodeCursor,
  extractPdfText,
  LIST_NEW_SINCE_MAX_PAGES,
  LoginRequiredError,
  listNewSince,
  mailboxSummary,
  type PublicMessage,
  readAccountStatus,
  searchMessages,
  subjectDates,
  writeDownload,
} from '@digitalpost/client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DigitalPostContext } from './context.ts';
import { EBOKS_TOOL_NAMES, registerEboksTools } from './eboks-tools.ts';
import { jsonResult, type ToolResult, toolFailure } from './tool-error.ts';

export { EBOKS_TOOL_NAMES, MARKS_READ_TOOL_NAMES } from './eboks-tools.ts';

export function toolNamesFor(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return eboksEnabled(env) ? [...TOOL_NAMES, ...EBOKS_TOOL_NAMES] : TOOL_NAMES;
}

export const TOOL_NAMES = [
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
] as const;

const mailboxId = z
  .string()
  .min(1)
  .optional()
  .describe('Mailbox id from digitalpost.discover. Defaults to the citizen mailbox.');
const messageId = z.string().min(1).describe('Message id.');
const documentId = z.string().min(1).describe('Document id from the message.');
const fileId = z.string().min(1).describe('File id inside the document.');

async function guarded(action: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return jsonResult(await action());
  } catch (error) {
    return toolFailure(error);
  }
}

export async function discover(context: DigitalPostContext): Promise<{
  loggedIn: boolean;
  status: string;
  username: string | null;
  mailboxes: Awaited<ReturnType<DigitalPostContext['mailboxes']>>;
  message?: string;
  accessExpiresAt?: string;
}> {
  const stored = await context.session.status();
  if (stored?.status !== 'ok' || !stored?.tokens) {
    return {
      loggedIn: false,
      status: stored?.status ?? 'anonymous',
      username: stored?.username ?? null,
      mailboxes: [],
      message: 'Login required. Run `digitalpost login`.',
    };
  }
  const mailboxes = await context.mailboxes();
  return {
    loggedIn: true,
    status: 'ok',
    username: stored.username,
    accessExpiresAt: new Date(stored.tokens.expiresAt).toISOString(),
    mailboxes,
  };
}

export function registerTools(
  server: McpServer,
  context: DigitalPostContext,
  env: NodeJS.ProcessEnv = process.env,
): void {
  server.registerTool(
    'digitalpost.discover',
    {
      title: 'Who am I / mailboxes',
      description:
        'Login status and the mailboxes this login can read (citizen offentlig post, and organisation mailboxes the person can open). ' +
        'Does not mark anything read. Call this first. If status is login_required, stop and ask the user to run `digitalpost login`.',
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await discover(context));
      } catch (error) {
        if (error instanceof LoginRequiredError) {
          return jsonResult({ status: 'login_required', message: error.message }, true);
        }
        const message = error instanceof Error ? error.message : 'Digital Post request failed.';
        return jsonResult({ status: 'error', message }, true);
      }
    },
  );

  server.registerTool(
    'digitalpost.list_folders',
    {
      title: 'List folders',
      description:
        'Folders in a mailbox. folderType is INBOX, DRAFTS, SENT, DELETED, or USER_DEFINED. Read-only.',
      annotations: { readOnlyHint: true },
      inputSchema: { mailboxId },
    },
    async (args) =>
      guarded(async () => {
        const mailbox = await context.resolveMailbox(args.mailboxId);
        const folders = await context.folders(mailbox.id);
        return { mailbox, folders, cacheTtlSeconds: 60 };
      }),
  );

  server.registerTool(
    'digitalpost.list_messages',
    {
      title: 'List messages',
      description:
        'One page of messages, newest first. Filters: folderId, unread (local), since (ISO timestamp), sender, search. ' +
        'Page length is `size` (alias `limit`), max 100, default 20. Pagination is zero-based. ' +
        'Reading does not mark letters read.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        mailboxId,
        folderId: z.string().min(1).optional().describe('Folder id. Omit for the whole mailbox.'),
        unread: z
          .boolean()
          .optional()
          .describe('When true, keep only messages with read=false on this page.'),
        since: z
          .string()
          .optional()
          .describe('ISO-8601 timestamp. Messages received on or after this moment.'),
        sender: z.string().optional().describe('Case-insensitive match against the sender label.'),
        search: z
          .string()
          .optional()
          .describe(
            'Search text (Digital Post `any` parameter, then a local subject/sender check).',
          ),
        page: z.number().int().nonnegative().optional().describe('Zero-based page. Default 0.'),
        size: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe('Page size, max 100. Default 20.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe('Alias for size. Page size, max 100. Default 20.'),
        cursor: z
          .string()
          .optional()
          .describe(
            'Opaque nextCursor from the previous page. When set, it replaces the other filters.',
          ),
      },
    },
    async (args) =>
      guarded(async () => {
        const query = args.cursor ? pageCursor(args.cursor) : args;
        const mailbox = await context.resolveMailbox(query.mailboxId);
        const pageNumber = query.page ?? 0;
        const page = await context.api().listMessages(mailbox.id, {
          ...(query.folderId ? { folderId: query.folderId } : {}),
          ...(query.unread !== undefined ? { unread: query.unread } : {}),
          ...(query.since ? { since: query.since } : {}),
          ...(query.sender ? { sender: query.sender } : {}),
          ...(query.search ? { search: query.search } : {}),
          page: pageNumber,
          ...pageSizeArg(query),
        });
        const hasNext =
          page.rawCount === page.size &&
          (page.totalPages == null || pageNumber + 1 < page.totalPages);
        return {
          mailboxId: mailbox.id,
          ...page,
          nextCursor: hasNext
            ? encodeCursor('page', {
                page: pageNumber + 1,
                mailboxId: query.mailboxId,
                folderId: query.folderId,
                unread: query.unread,
                since: query.since,
                sender: query.sender,
                search: query.search,
                size: page.size,
              })
            : null,
        };
      }),
  );

  server.registerTool(
    'digitalpost.search_messages',
    {
      title: 'Search letters',
      description:
        'Search one or all mailboxes by sender, subject, free text, date range, unread, and attachments. ' +
        'Sender, subject, and dates are sent to the gateway. Unread and attachments are applied to the pages that were fetched (at most 5 pages of 100 per call). ' +
        'Pass nextCursor to continue. Does not mark letters read.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        mailboxId,
        folderId: z.string().min(1).optional().describe('Limit the search to one folder.'),
        sender: z.string().optional().describe('Sender label. Matched as a contains search.'),
        subject: z.string().optional().describe('Subject text. Matched as a contains search.'),
        text: z.string().optional().describe('Free text across letter fields (gateway `any`).'),
        from: z.string().optional().describe('Received on or after this ISO date or timestamp.'),
        to: z.string().optional().describe('Received on or before this ISO date or timestamp.'),
        unread: z.boolean().optional().describe('When true, keep unread letters only.'),
        hasAttachments: z
          .boolean()
          .optional()
          .describe('When true, keep letters that have a file.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe('Max letters to return. Default 50.'),
        cursor: z
          .string()
          .optional()
          .describe('nextCursor from the previous search. Do not mix with new filters.'),
      },
    },
    async (args) => guarded(() => runSearch(context, args)),
  );

  server.registerTool(
    'digitalpost.get_message',
    {
      title: 'Get one message',
      description:
        'Metadata for one letter: sender, subject, received date, read flag, and the document/file list. Does not download bytes and does not mark the letter read.',
      annotations: { readOnlyHint: true },
      inputSchema: { mailboxId, messageId },
    },
    async (args) =>
      guarded(async () => {
        const mailbox = await context.resolveMailbox(args.mailboxId);
        const message = await context.api().getMessage(mailbox.id, args.messageId);
        return message;
      }),
  );

  server.registerTool(
    'digitalpost.get_document',
    {
      title: 'Download a document file',
      description:
        'Download one file (usually a PDF) into the local download directory and return the path. Does not mark the letter read. The path stays inside DIGITALPOST_DOWNLOAD_DIR.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        mailboxId,
        messageId,
        documentId,
        fileId,
        filename: z
          .string()
          .optional()
          .describe('Suggested filename. Unsafe characters are stripped.'),
      },
    },
    async (args) =>
      guarded(async () => {
        const mailbox = await context.resolveMailbox(args.mailboxId);
        const message = await context.api().getMessage(mailbox.id, args.messageId);
        const file = findFile(message, args.documentId, args.fileId);
        const downloaded = await context
          .api()
          .getFileContent(mailbox.id, args.messageId, args.documentId, args.fileId);
        const path = await writeDownload(
          context.paths.downloadDir,
          downloaded.bytes,
          args.filename || file?.filename || 'document.bin',
        );
        return {
          path,
          bytes: downloaded.bytes.byteLength,
          mimeType: file?.mimeType ?? downloaded.contentType,
          filename: file?.filename ?? null,
        };
      }),
  );

  server.registerTool(
    'digitalpost.extract_pdf_text',
    {
      title: 'Extract text from a PDF letter',
      description:
        'Download a PDF file (or read one already saved in the download directory) and return its text so you can read the letter. Does not mark the letter read. Text is not written to the log.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        mailboxId,
        messageId: messageId.optional(),
        documentId: documentId.optional(),
        fileId: fileId.optional(),
        path: z
          .string()
          .optional()
          .describe(
            'Existing file inside the download directory. When set, the message ids are not required.',
          ),
      },
    },
    async (args) =>
      guarded(async () => {
        const bytes = args.path
          ? new Uint8Array(
              await readFile(await assertInsideDownloadDir(context.paths.downloadDir, args.path)),
            )
          : await downloadPdf(context, args);
        const extracted = await extractPdfText(bytes);
        return extracted;
      }),
  );

  server.registerTool(
    'digitalpost.list_new_since',
    {
      title: 'Letters since a timestamp',
      description:
        'Messages received at or after an ISO timestamp, newest first. Each row includes heuristic dates from the subject. Does not download PDFs and does not mark letters read. Use digitalpost.digest for a grouped overview.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        since: z.string().min(4).describe('ISO-8601 timestamp.'),
        mailboxId,
        folderId: z.string().optional(),
        unread: z.boolean().optional().describe('When true, only unread messages.'),
        maxPages: z
          .number()
          .int()
          .positive()
          .max(LIST_NEW_SINCE_MAX_PAGES)
          .optional()
          .describe('Pages of 100 letters per mailbox. Default 3, maximum 10.'),
      },
    },
    async (args) =>
      guarded(async () => {
        const api = context.api();
        const ids = args.mailboxId
          ? [(await context.resolveMailbox(args.mailboxId)).id]
          : (await context.mailboxes()).map((box) => box.id);
        const messages = await listNewSince(api, ids, {
          since: args.since,
          ...(args.folderId ? { folderId: args.folderId } : {}),
          ...(args.unread ? { unread: true } : {}),
          ...(args.maxPages !== undefined ? { maxPages: args.maxPages } : {}),
        });
        return {
          since: args.since,
          count: messages.length,
          datesAreHeuristic: true,
          note: DATES_NOTE,
          messages: messages.map((message) => ({
            ...message,
            unread: message.read == null ? null : message.read === false,
            detectedDates: subjectDates(message),
          })),
        };
      }),
  );

  server.registerTool(
    'digitalpost.digest',
    {
      title: 'Morning digest',
      description:
        'New letters grouped by mailbox, with sender, subject, received time, unread flag, and detected dates. ' +
        'Dates from the subject and from up to 3 Digital Post PDFs are heuristics. Downloading a Digital Post PDF does not mark it read. e-Boks content is not downloaded.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        since: z.string().min(4).describe('ISO-8601 timestamp.'),
        mailboxId,
        folderId: z.string().optional(),
        unread: z.boolean().optional(),
        includePdf: z
          .boolean()
          .optional()
          .describe('When false, only the subject is parsed. Default true, capped at pdfLimit.'),
        pdfLimit: z
          .number()
          .int()
          .positive()
          .max(8)
          .optional()
          .describe('How many Digital Post PDFs to read. Default 3, max 8.'),
        maxPages: z
          .number()
          .int()
          .positive()
          .max(LIST_NEW_SINCE_MAX_PAGES)
          .optional()
          .describe('Pages of 100 letters per mailbox. Default 3, maximum 10.'),
      },
    },
    async (args) => guarded(() => runDigest(context, args)),
  );

  server.registerTool(
    'digitalpost.extract_dates',
    {
      title: 'Dates in one letter',
      description:
        'Dates, times, and places found in one Digital Post letter, for checking against a calendar. ' +
        'Text matches are heuristics. replyBy comes from the gateway. PDF text is included by default and does not mark the letter read.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        mailboxId,
        messageId,
        includePdf: z.boolean().optional().describe('Read the first PDF. Default true.'),
      },
    },
    async (args) => guarded(() => runExtractDates(context, args)),
  );

  server.registerTool(
    'digitalpost.status',
    {
      title: 'Login status',
      description:
        'Logged-in state, access-token expiry, last successful renew, and the mailbox list. No tokens or keys.',
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => guarded(() => runStatus(context)),
  );

  server.registerTool(
    'digitalpost.mailbox_summary',
    {
      title: 'Folder and sender counts',
      description:
        'Folder totals from the gateway and sender counts from the newest 100 letters. Does not mark anything read. Unread is not a folder total.',
      annotations: { readOnlyHint: true },
      inputSchema: { mailboxId },
    },
    async (args) => guarded(() => runMailboxSummary(context, args.mailboxId)),
  );

  if (eboksEnabled(env)) registerEboksTools(server, context);
}

/** `size` wins when both are set. `limit` is the name some callers use for the same page length. */
export function pageSizeArg(input: {
  size?: number | undefined;
  limit?: number | undefined;
}): { size: number } | Record<string, never> {
  const size = input.size ?? input.limit;
  return size === undefined ? {} : { size };
}

interface PageQuery {
  mailboxId?: string | undefined;
  folderId?: string | undefined;
  unread?: boolean | undefined;
  since?: string | undefined;
  sender?: string | undefined;
  search?: string | undefined;
  page?: number | undefined;
  size?: number | undefined;
  limit?: number | undefined;
}

function pageCursor(cursor: string): PageQuery {
  const decoded = decodeCursor('page', cursor);
  if (!decoded || typeof decoded !== 'object') {
    throw new DigitalPostError('That cursor is not valid. Start again without one.');
  }
  const record = decoded as Record<string, unknown>;
  const page = record.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 0) {
    throw new DigitalPostError('That cursor is not valid. Start again without one.');
  }
  return {
    page,
    ...(typeof record.mailboxId === 'string' ? { mailboxId: record.mailboxId } : {}),
    ...(typeof record.folderId === 'string' ? { folderId: record.folderId } : {}),
    ...(typeof record.unread === 'boolean' ? { unread: record.unread } : {}),
    ...(typeof record.since === 'string' ? { since: record.since } : {}),
    ...(typeof record.sender === 'string' ? { sender: record.sender } : {}),
    ...(typeof record.search === 'string' ? { search: record.search } : {}),
    ...(typeof record.size === 'number' ? { size: record.size } : {}),
  };
}

export async function runSearch(
  context: DigitalPostContext,
  args: {
    mailboxId?: string | undefined;
    folderId?: string | undefined;
    sender?: string | undefined;
    subject?: string | undefined;
    text?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    unread?: boolean | undefined;
    hasAttachments?: boolean | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  },
): Promise<unknown> {
  const mailboxes = args.cursor
    ? []
    : args.mailboxId
      ? [await context.resolveMailbox(args.mailboxId)]
      : await context.mailboxes();
  return searchMessages(context.api(), {
    mailboxIds: mailboxes.map((box) => box.id),
    ...(args.folderId ? { folderId: args.folderId } : {}),
    ...(args.sender ? { sender: args.sender } : {}),
    ...(args.subject ? { subject: args.subject } : {}),
    ...(args.text ? { text: args.text } : {}),
    ...(args.from ? { from: args.from } : {}),
    ...(args.to ? { to: args.to } : {}),
    ...(args.unread ? { unread: true } : {}),
    ...(args.hasAttachments ? { hasAttachments: true } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.cursor ? { cursor: args.cursor } : {}),
  });
}

export async function runDigest(
  context: DigitalPostContext,
  args: {
    since: string;
    mailboxId?: string | undefined;
    folderId?: string | undefined;
    unread?: boolean | undefined;
    includePdf?: boolean | undefined;
    pdfLimit?: number | undefined;
    maxPages?: number | undefined;
  },
): Promise<unknown> {
  const mailboxes = args.mailboxId
    ? [await context.resolveMailbox(args.mailboxId)]
    : await context.mailboxes();
  return buildDigest(context.api(), mailboxes, {
    since: args.since,
    ...(args.folderId ? { folderId: args.folderId } : {}),
    ...(args.unread ? { unread: true } : {}),
    ...(args.includePdf !== undefined ? { includePdf: args.includePdf } : {}),
    ...(args.pdfLimit !== undefined ? { pdfLimit: args.pdfLimit } : {}),
    ...(args.maxPages !== undefined ? { maxPages: args.maxPages } : {}),
  });
}

export async function runExtractDates(
  context: DigitalPostContext,
  args: { mailboxId?: string | undefined; messageId: string; includePdf?: boolean | undefined },
): Promise<unknown> {
  const mailbox = await context.resolveMailbox(args.mailboxId);
  const message = await context.api().getMessage(mailbox.id, args.messageId);
  let pdfText: string | null = null;
  if (args.includePdf !== false) {
    const file = firstPdfFile(message);
    if (file) {
      const downloaded = await context
        .api()
        .getFileContent(mailbox.id, message.id, file.documentId, file.fileId);
      pdfText = (await extractPdfText(downloaded.bytes)).text;
    }
  }
  return {
    heuristic: true,
    note: DATES_NOTE,
    messageId: message.id,
    subject: message.subject,
    officialReplyBy: message.replyBy,
    pdfTextUsed: pdfText != null,
    dates: datesFromLetter({
      subject: message.subject,
      receivedAt: message.receivedAt,
      replyBy: message.replyBy,
      pdfText,
    }),
  };
}

export async function runStatus(context: DigitalPostContext): Promise<unknown> {
  const device = await new EboksDeviceStore(context.paths).load().catch(() => null);
  return readAccountStatus({
    session: context.session,
    listMailboxes: () => context.mailboxes(),
    eboksRegistered: Boolean(device?.activated),
  });
}

export async function runMailboxSummary(
  context: DigitalPostContext,
  mailboxId?: string,
): Promise<unknown> {
  const mailbox = await context.resolveMailbox(mailboxId);
  const folders = await context.folders(mailbox.id);
  return mailboxSummary(context.api(), mailbox, folders);
}

function firstPdfFile(message: PublicMessage): { documentId: string; fileId: string } | null {
  for (const document of message.documents) {
    for (const file of document.files) {
      const name = file.filename?.toLowerCase() ?? '';
      const mime = file.mimeType?.toLowerCase() ?? '';
      if (mime.includes('pdf') || name.endsWith('.pdf')) {
        return { documentId: document.id, fileId: file.id };
      }
    }
  }
  return null;
}

function findFile(message: PublicMessage, documentId: string, fileId: string) {
  for (const document of message.documents) {
    if (document.id !== documentId) continue;
    return document.files.find((file) => file.id === fileId) ?? null;
  }
  return null;
}

async function downloadPdf(
  context: DigitalPostContext,
  args: {
    mailboxId?: string | undefined;
    messageId?: string | undefined;
    documentId?: string | undefined;
    fileId?: string | undefined;
  },
): Promise<Uint8Array> {
  if (!args.messageId || !args.documentId || !args.fileId) {
    throw new DigitalPostError('Provide path, or messageId, documentId, and fileId.');
  }
  const mailbox = await context.resolveMailbox(args.mailboxId);
  const downloaded = await context
    .api()
    .getFileContent(mailbox.id, args.messageId, args.documentId, args.fileId);
  return downloaded.bytes;
}
