import type { DigitalPostApi } from './api.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { ApiError, DigitalPostError } from './errors.ts';
import { assertPathSegment } from './ids.ts';
import type { PublicMessage } from './redact.ts';
import { compareInstants } from './time.ts';

export interface SearchInput {
  mailboxIds: string[];
  folderId?: string;
  folderIds?: string[];
  sender?: string;
  subject?: string;
  text?: string;
  from?: string;
  to?: string;
  unread?: boolean;
  hasAttachments?: boolean;
  limit?: number;
  cursor?: string;
  maxPages?: number;
}

interface SearchTarget {
  mailboxId: string;
  folderId?: string;
  page: number;
}

interface SearchState {
  targets: SearchTarget[];
  skip: number;
  limit: number;
  maxPages: number;
  sender?: string;
  subject?: string;
  text?: string;
  from?: string;
  to?: string;
  unread?: boolean;
  hasAttachments?: boolean;
}

export interface SearchPage {
  messages: PublicMessage[];
  count: number;
  truncated: boolean;
  nextCursor: string | null;
  scannedPages: number;
  note: string;
}

const NOTE =
  'Sender, subject, and the date range are sent to the gateway and checked again locally. Unread and attachments are filtered on the pages that were fetched. One call scans at most 5 pages of 100 per mailbox or folder.';

export async function searchMessages(api: DigitalPostApi, input: SearchInput): Promise<SearchPage> {
  const state = resolveState(input);
  const collected: PublicMessage[] = [];
  let scannedPages = 0;
  let skip = state.skip;

  while (
    state.targets.length > 0 &&
    collected.length < state.limit &&
    scannedPages < state.maxPages
  ) {
    const target = state.targets[0];
    if (!target) break;
    let batch: Awaited<ReturnType<DigitalPostApi['listMessages']>>;
    try {
      batch = await api.listMessages(target.mailboxId, {
        page: target.page,
        size: 100,
        ...(target.folderId ? { folderId: target.folderId } : {}),
        ...(state.from ? { since: state.from } : {}),
        ...(state.to ? { until: state.to } : {}),
        ...(state.sender ? { sender: state.sender, senderWildcard: true } : {}),
        ...(state.subject ? { subject: state.subject } : {}),
        ...(state.text ? { search: state.text } : {}),
        ...(state.unread ? { unread: true } : {}),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        state.targets.shift();
        skip = 0;
        continue;
      }
      throw error;
    }
    scannedPages += 1;
    let matched = batch.messages;
    if (state.hasAttachments) matched = matched.filter(hasFiles);
    const rest = matched.slice(skip);
    skip = 0;
    const before = collected.length;
    for (const message of rest) {
      if (collected.length >= state.limit) break;
      collected.push({ ...message, mailboxId: message.mailboxId || target.mailboxId });
    }
    const consumed = collected.length - before;
    if (collected.length >= state.limit && rest.length - consumed > 0) {
      return finish(collected, state, matched.length - (rest.length - consumed), scannedPages);
    }
    const pageExhausted =
      batch.rawCount === 0 ||
      batch.rawCount < batch.size ||
      (batch.totalPages != null && target.page + 1 >= batch.totalPages);
    const older =
      state.from != null &&
      batch.oldestReceivedAt != null &&
      compareInstants(batch.oldestReceivedAt, state.from) < 0;
    if (pageExhausted || older) state.targets.shift();
    else target.page += 1;
  }

  const more = state.targets.length > 0;
  return {
    messages: collected,
    count: collected.length,
    truncated: more,
    nextCursor: more ? encodeCursor('search', { ...state, skip: 0 }) : null,
    scannedPages,
    note: NOTE,
  };
}

function finish(
  collected: PublicMessage[],
  state: SearchState,
  skip: number,
  scannedPages: number,
): SearchPage {
  return {
    messages: collected,
    count: collected.length,
    truncated: true,
    nextCursor: encodeCursor('search', { ...state, skip }),
    scannedPages,
    note: NOTE,
  };
}

function resolveState(input: SearchInput): SearchState {
  if (input.cursor) {
    const decoded = decodeCursor('search', input.cursor);
    if (!decoded || typeof decoded !== 'object') {
      throw new DigitalPostError('That cursor is not valid. Start again without one.');
    }
    return normalizeState(decoded as Partial<SearchState>);
  }
  const mailboxIds = input.mailboxIds.map((id) => assertPathSegment(id, 'mailbox id'));
  if (mailboxIds.length === 0) throw new DigitalPostError('Search needs at least one mailbox.');
  const folderIds = (input.folderIds ?? (input.folderId ? [input.folderId] : [])).map((id) =>
    assertPathSegment(id, 'folder id'),
  );
  const targets: SearchTarget[] =
    folderIds.length > 0
      ? mailboxIds.flatMap((mailboxId) =>
          folderIds.map((folderId) => ({ mailboxId, folderId, page: 0 })),
        )
      : mailboxIds.map((mailboxId) => ({ mailboxId, page: 0 }));
  return {
    targets,
    skip: 0,
    limit: clamp(input.limit, 50, 100),
    maxPages: clamp(input.maxPages, 5, 10),
    ...(input.sender ? { sender: input.sender } : {}),
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.text ? { text: input.text } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    ...(input.unread ? { unread: true } : {}),
    ...(input.hasAttachments ? { hasAttachments: true } : {}),
  };
}

function normalizeState(raw: Partial<SearchState>): SearchState {
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new DigitalPostError('That cursor is not valid. Start again without one.');
  }
  const targets = raw.targets.map((target) => {
    if (!target || typeof target !== 'object') {
      throw new DigitalPostError('That cursor is not valid. Start again without one.');
    }
    const mailboxId = assertPathSegment(String(target.mailboxId ?? ''), 'mailbox id');
    const page = target.page;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 0 || page > 10_000) {
      throw new DigitalPostError('That cursor is not valid. Start again without one.');
    }
    const folderId =
      target.folderId == null ? undefined : assertPathSegment(String(target.folderId), 'folder id');
    return { mailboxId, page, ...(folderId ? { folderId } : {}) };
  });
  return {
    targets,
    skip: typeof raw.skip === 'number' && raw.skip >= 0 ? Math.floor(raw.skip) : 0,
    limit: clamp(raw.limit, 50, 100),
    maxPages: clamp(raw.maxPages, 5, 10),
    ...(typeof raw.sender === 'string' ? { sender: raw.sender } : {}),
    ...(typeof raw.subject === 'string' ? { subject: raw.subject } : {}),
    ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
    ...(typeof raw.from === 'string' ? { from: raw.from } : {}),
    ...(typeof raw.to === 'string' ? { to: raw.to } : {}),
    ...(raw.unread === true ? { unread: true } : {}),
    ...(raw.hasAttachments === true ? { hasAttachments: true } : {}),
  };
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value == null || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

function hasFiles(message: PublicMessage): boolean {
  return message.documents.some((document) => document.files.length > 0);
}
