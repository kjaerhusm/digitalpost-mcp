/**
 * Read-only Digital Post view API.
 *
 * Every call goes through `guardedMailFetch`, which rejects anything except
 * GET against `gateway.digitalpost.dk/apis/v1` before the request is sent.
 * There is no method on this class that marks mail read, moves it, deletes
 * it, or sends it. GET does not change read state (Digital Post OpenAPI /
 * ebox observations, 2026).
 */

import { MAX_PAGE_SIZE } from './constants.ts';
import { ApiError, LoginRequiredError } from './errors.ts';
import { type FetchLike, guardedMailFetch, mailUrl } from './guard.ts';
import { assertPathSegment } from './ids.ts';
import {
  type PublicFolder,
  type PublicMailbox,
  type PublicMessage,
  toPublicFolder,
  toPublicMailbox,
  toPublicMessage,
} from './redact.ts';
import { REQUEST_TIMEOUT_MS, sendWithRetry } from './retry.ts';
import { parseFolderList, parseMailboxList, parseMessage, parseMessageList } from './schema.ts';
import { compareInstants } from './time.ts';

export interface ListMessagesInput {
  folderId?: string;
  /** ISO-8601 timestamp. Sent as `receivedDateFrom` (date) and filtered again locally. */
  since?: string;
  /** Matched against `sender.label` (server query plus a local contains check). */
  sender?: string;
  /** When true, `sender.label` is sent as a contains wildcard. */
  senderWildcard?: boolean;
  /** Subject text. Sent as the `label` field search, then checked locally. */
  subject?: string;
  /** ISO date or timestamp. Sent as `receivedDateTo` (date) and filtered locally. */
  until?: string;
  /** Free text. Sent as the OpenAPI `any` search parameter. */
  search?: string;
  /** Applied locally. The list endpoint has no unread query flag, and the
   *  unread-exists endpoint requires a CPR, which this client does not send. */
  unread?: boolean;
  page?: number;
  size?: number;
}

export interface MessagePage {
  messages: PublicMessage[];
  page: number;
  size: number;
  /** Rows the API returned before local filters. Paging must use this, not `messages.length`. */
  rawCount: number;
  /** Received time of the last row on the raw page (newest-first, so the oldest on the page). */
  oldestReceivedAt: string | null;
  totalElements: number | null;
  totalPages: number | null;
  /** True when a local filter removed rows from the page the API returned. */
  clientFiltered: boolean;
}

export interface DigitalPostApiOptions {
  accessToken: () => Promise<string>;
  /** Force a refresh and return a new access token. Used once after HTTP 401. */
  refreshAccessToken?: () => Promise<string>;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export class DigitalPostApi {
  private readonly accessToken: () => Promise<string>;
  private readonly refreshAccessToken: (() => Promise<string>) | null;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: DigitalPostApiOptions) {
    this.accessToken = options.accessToken;
    this.refreshAccessToken = options.refreshAccessToken ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async listMailboxes(): Promise<PublicMailbox[]> {
    const path = '/mailboxes/';
    const json = await this.getJson(path, new URLSearchParams({ size: '100' }));
    return parseMailboxList(json, path).map((item) =>
      toPublicMailbox(item as Parameters<typeof toPublicMailbox>[0]),
    );
  }

  async listFolders(mailboxId: string): Promise<PublicFolder[]> {
    const id = assertPathSegment(mailboxId, 'mailbox id');
    const path = `/mailboxes/${encodeURIComponent(id)}/folders/`;
    const json = await this.getJson(path, new URLSearchParams({ size: '1000' }));
    return parseFolderList(json, path).map((item) =>
      toPublicFolder(item as Parameters<typeof toPublicFolder>[0]),
    );
  }

  async listMessages(mailboxId: string, input: ListMessagesInput = {}): Promise<MessagePage> {
    const id = assertPathSegment(mailboxId, 'mailbox id');
    const page = input.page ?? 0;
    const size = clampSize(input.size);
    const query = buildMessageQuery({ ...input, page, size });
    const path = `/mailboxes/${encodeURIComponent(id)}/messages/`;
    const json = await this.getJson(path, query);
    const parsed = parseMessageList(json, path);
    const raw = parsed.messages.map((item) =>
      toPublicMessage(item as Parameters<typeof toPublicMessage>[0]),
    );
    const filtered = raw.filter((message) => passesLocalFilters(message, input));
    return {
      messages: filtered,
      page,
      size,
      rawCount: raw.length,
      oldestReceivedAt: raw[raw.length - 1]?.receivedAt ?? null,
      totalElements: parsed.totalElements,
      totalPages: parsed.totalPages,
      clientFiltered: filtered.length !== raw.length,
    };
  }

  async getMessage(mailboxId: string, messageId: string): Promise<PublicMessage> {
    const box = assertPathSegment(mailboxId, 'mailbox id');
    const message = assertPathSegment(messageId, 'message id');
    const path = `/mailboxes/${encodeURIComponent(box)}/messages/${encodeURIComponent(message)}`;
    const json = await this.getJson(path);
    return toPublicMessage(parseMessage(json, path) as Parameters<typeof toPublicMessage>[0]);
  }

  /**
   * Download one file. The bytes are returned to the caller, which writes
   * them to disk. Nothing is logged.
   */
  async getFileContent(
    mailboxId: string,
    messageId: string,
    documentId: string,
    fileId: string,
  ): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const path =
      `/mailboxes/${encodeURIComponent(assertPathSegment(mailboxId, 'mailbox id'))}` +
      `/messages/${encodeURIComponent(assertPathSegment(messageId, 'message id'))}` +
      `/documents/${encodeURIComponent(assertPathSegment(documentId, 'document id'))}` +
      `/files/${encodeURIComponent(assertPathSegment(fileId, 'file id'))}/content`;
    const response = await this.get(path);
    const buffer = new Uint8Array(await response.arrayBuffer());
    return { bytes: buffer, contentType: response.headers.get('content-type') };
  }

  private async getJson(path: string, query?: URLSearchParams): Promise<unknown> {
    const response = await this.get(path, query);
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ApiError(`Digital Post returned non-JSON for ${path}.`, response.status, path);
    }
  }

  private async get(path: string, query?: URLSearchParams, refreshed = false): Promise<Response> {
    const url = mailUrl(path, query);
    let token: string;
    try {
      token = await this.accessToken();
    } catch (error) {
      if (error instanceof LoginRequiredError) throw error;
      throw error;
    }
    const response = await this.send(url, token, path);
    if (response.status === 401 && !refreshed && this.refreshAccessToken) {
      await response.body?.cancel().catch(() => undefined);
      const next = await this.refreshAccessToken();
      const retry = await this.send(url, next, path);
      if (!retry.ok) throw httpError(retry.status, path);
      return retry;
    }
    if (!response.ok) throw httpError(response.status, path);
    return response;
  }

  private send(url: string, token: string, path: string): Promise<Response> {
    return sendWithRetry({
      path,
      sleep: this.sleep,
      send: () =>
        guardedMailFetch(this.fetchImpl, 'GET', url, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json, application/pdf, application/octet-stream, */*',
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
    });
  }
}

export function buildMessageQuery(
  input: ListMessagesInput & { page: number; size: number },
): URLSearchParams {
  const query = new URLSearchParams();
  query.set('page', String(input.page));
  query.set('size', String(input.size));
  query.set('sortFields', 'receivedDateTime:desc');
  if (input.folderId) query.set('folderId', input.folderId);
  if (input.since) query.set('receivedDateFrom', input.since.slice(0, 10));
  if (input.until) query.set('receivedDateTo', input.until.slice(0, 10));
  if (input.search) query.set('any', input.search);
  if (input.sender) {
    query.set('sender.label', input.senderWildcard ? containsQuery(input.sender) : input.sender);
  }
  if (input.subject) query.set('label', containsQuery(input.subject));
  return query;
}

/** OpenAPI field search: `*` is a wildcard. A comma would mean OR, so it is left as written. */
export function containsQuery(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('*') || trimmed.includes(',')) return trimmed;
  return `*${trimmed}*`;
}

function passesLocalFilters(message: PublicMessage, input: ListMessagesInput): boolean {
  if (input.unread && message.read !== false) return false;
  if (input.sender) {
    const needle = input.sender.toLowerCase().replaceAll('*', '');
    if (!(message.sender ?? '').toLowerCase().includes(needle)) return false;
  }
  if (input.subject) {
    const needle = input.subject.toLowerCase().replaceAll('*', '');
    if (!(message.subject ?? '').toLowerCase().includes(needle)) return false;
  }
  if (input.since && message.receivedAt && compareInstants(message.receivedAt, input.since) < 0) {
    return false;
  }
  if (
    input.until &&
    message.receivedAt &&
    compareInstants(message.receivedAt, untilInstant(input.until)) > 0
  ) {
    return false;
  }
  return true;
}

function untilInstant(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
}

function clampSize(size: number | undefined): number {
  if (!size || size < 1) return 20;
  return Math.min(size, MAX_PAGE_SIZE);
}

function httpError(status: number, path: string): ApiError {
  const hint =
    status >= 500
      ? 'The gateway had a temporary error. Nothing was changed. Try again shortly.'
      : status === 404
        ? 'That mailbox, folder, or letter was not found.'
        : 'The request failed. Nothing was changed.';
  return new ApiError(`Digital Post responded HTTP ${status} for ${path}.`, status, path, hint);
}
