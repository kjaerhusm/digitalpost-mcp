import type { DigitalPostPaths } from './config.ts';
import { EBOKS_API_BASE } from './constants.ts';
import {
  buildRegisterDeviceRequest,
  buildVerifyPasswordRequest,
  type EboksAccess,
  exchangeEboksToken,
  tokenStillFresh,
} from './eboks-auth.ts';
import { EboksDeviceStore, type StoredEboksDevice } from './eboks-device.ts';
import { assertEboksMailRead } from './eboks-guard.ts';
import { DigitalPostError, RateLimitedError, UpstreamChangedError } from './errors.ts';
import { guardedFetch } from './guarded-fetch.ts';
import { assertPathSegment } from './ids.ts';
import { isCprShaped } from './redact.ts';
import { REQUEST_TIMEOUT_MS, sendWithRetry } from './retry.ts';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface EboksFolder {
  id: string;
  name: string | null;
  type: string | null;
  parentId: string | null;
}

export interface EboksBodyFile {
  filename: string | null;
  mimeType: string | null;
  size: number | null;
}

export interface EboksMessage {
  id: string;
  folderId: string | null;
  subject: string | null;
  sender: string | null;
  receivedAt: string | null;
  unread: boolean | null;
  attachmentCount: number | null;
  attachments: EboksAttachment[];
  /** The letter file named on the message metadata. Not the bytes. */
  bodyFile: EboksBodyFile | null;
}

export interface EboksContent {
  bytes: Uint8Array;
  contentType: string | null;
  /** e-Boks marks the letter read when these bytes are downloaded. */
  markedRead: true;
}

export const EBOKS_CONTENT_WARNING =
  'e-Boks marks this letter read when its content is downloaded. This program cannot undo that.';

export interface EboksAttachment {
  id: string;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
}

export interface EboksShare {
  userId: string;
  name: string | null;
  permission: string | null;
  status: string | null;
}

export interface EboksProfile {
  registered: true;
  name: string | null;
}

export interface EboksApiOptions {
  digitalPostAccessToken: () => Promise<string>;
  device: StoredEboksDevice;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Read-only e-Boks mobile client.
 * Lists folders and message metadata. Letter bytes are never requested:
 * e-Boks would mark the message read.
 */
export class EboksApi {
  private readonly digitalPostAccessToken: () => Promise<string>;
  private readonly device: StoredEboksDevice;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private access: EboksAccess | null = null;

  constructor(options: EboksApiOptions) {
    this.digitalPostAccessToken = options.digitalPostAccessToken;
    this.device = options.device;
    this.fetchImpl = options.fetchImpl ?? guardedFetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async profile(): Promise<EboksProfile> {
    const json = asRecord(await this.getJson('/user/profile'));
    return { registered: true, name: stringOrNull(json.name) };
  }

  async shares(): Promise<EboksShare[]> {
    const json = await this.getJson('/mail/shares');
    const list = Array.isArray(json) ? json : arrayField(json, 'shares');
    return list
      .map((item) => {
        const record = asRecord(item);
        const userId = idString(record.userId);
        return {
          userId: isCprShaped(userId) ? '' : userId,
          name: stringOrNull(record.name),
          permission: stringOrNull(record.permission),
          status: stringOrNull(record.status),
        };
      })
      .filter((share) => share.userId.length > 0 && share.status === 'Accepted');
  }

  async listFolders(userId?: string | undefined): Promise<EboksFolder[]> {
    rejectCprUserId(userId);
    const json = await this.getJson('/mail/folders', userQuery(userId));
    const list = Array.isArray(json) ? json : expectArrayField(json, 'folders', '/mail/folders');
    return flattenFolders(list, null);
  }

  async listMessages(
    folderId: string,
    input: { offset?: number; limit?: number; userId?: string } = {},
  ): Promise<{ messages: EboksMessage[]; total: number | null }> {
    rejectCprUserId(input.userId);
    const query = new URLSearchParams({
      offset: String(input.offset ?? 0),
      limit: String(input.limit ?? 20),
    });
    if (input.userId) query.set('userId', input.userId);
    const json = await this.getJson(
      `/mail/folders/${encodeURIComponent(folderId)}/messages`,
      query,
    );
    const record = asRecord(json);
    const items = Array.isArray(record.items)
      ? record.items
      : expectArrayField(json, 'messages', `/mail/folders/${folderId}/messages`);
    const total = asRecord(record.metadata).total;
    return {
      messages: items.map((item) => toMessage(asRecord(item), folderId)),
      total: typeof total === 'number' ? total : null,
    };
  }

  async getMessage(
    folderId: string,
    messageId: string,
    userId?: string | undefined,
  ): Promise<EboksMessage> {
    rejectCprUserId(userId);
    const json = await this.getJson(
      `/mail/folders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(messageId)}`,
      userQuery(userId),
    );
    return toMessage(asRecord(json), folderId);
  }

  /**
   * Downloads one letter body. e-Boks marks that letter read. There is no
   * bulk download and no call that marks it unread again.
   */
  async getMessageContent(
    folderId: string,
    messageId: string,
    userId?: string | undefined,
  ): Promise<EboksContent> {
    rejectCprUserId(userId);
    const path =
      `/mail/folders/${encodeURIComponent(assertPathSegment(folderId, 'folder id'))}` +
      `/messages/${encodeURIComponent(assertPathSegment(messageId, 'message id'))}/content`;
    return this.readContent(path, userQuery(userId));
  }

  /** Downloads one attachment. e-Boks marks that letter read. */
  async getAttachmentContent(
    folderId: string,
    messageId: string,
    attachmentId: string,
    userId?: string | undefined,
  ): Promise<EboksContent> {
    rejectCprUserId(userId);
    const path =
      `/mail/folders/${encodeURIComponent(assertPathSegment(folderId, 'folder id'))}` +
      `/messages/${encodeURIComponent(assertPathSegment(messageId, 'message id'))}` +
      `/attachment/${encodeURIComponent(assertPathSegment(attachmentId, 'attachment id'))}/content`;
    return this.readContent(path, userQuery(userId));
  }

  private async readContent(path: string, query?: URLSearchParams): Promise<EboksContent> {
    const response = await this.get(path, query);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      contentType: response.headers.get('content-type'),
      markedRead: true,
    };
  }

  private async getJson(path: string, query?: URLSearchParams): Promise<unknown> {
    const response = await this.get(path, query);
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new UpstreamChangedError(path);
    }
  }

  private async get(path: string, query?: URLSearchParams, allowRefresh = true): Promise<Response> {
    const url = mailUrl(path, query);
    assertEboksMailRead('GET', url);
    const token = await this.token();
    let response: Response;
    try {
      response = await sendWithRetry({
        path,
        service: 'e-Boks',
        sleep: this.sleep,
        send: () =>
          this.fetchImpl(url, {
            method: 'GET',
            headers: { authorization: `Bearer ${token}`, accept: '*/*' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }),
      });
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      throw error;
    }
    if (response.status === 401 && allowRefresh) {
      await response.body?.cancel();
      this.access = null;
      return this.get(path, query, false);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DigitalPostError(`e-Boks responded HTTP ${response.status} for ${path}.`);
    }
    return response;
  }

  private async token(): Promise<string> {
    if (this.access && tokenStillFresh(this.access, this.now())) return this.access.accessToken;
    const digitalPost = await this.digitalPostAccessToken();
    this.access = await exchangeEboksToken(digitalPost, this.device.id, this.fetchImpl, this.now());
    return this.access.accessToken;
  }
}

/** One-time device registration. The password is used once and not stored. */
export async function registerEboksDevice(options: {
  digitalPostAccessToken: string;
  password: string;
  device: StoredEboksDevice;
  paths: DigitalPostPaths;
  fetchImpl?: FetchLike;
}): Promise<StoredEboksDevice> {
  const fetchImpl = options.fetchImpl ?? guardedFetch;
  const access = await exchangeEboksToken(
    options.digitalPostAccessToken,
    options.device.id,
    fetchImpl,
  );
  const verify = buildVerifyPasswordRequest(options.password);
  const verified = await fetchImpl(verify.url, {
    method: verify.method,
    headers: { ...verify.headers, authorization: `Bearer ${access.accessToken}` },
    ...(verify.body ? { body: verify.body } : {}),
  });
  if (!verified.ok) {
    throw new DigitalPostError(
      `e-Boks rejected the mobile-access password (HTTP ${verified.status}).`,
    );
  }
  const registration = buildRegisterDeviceRequest(options.device);
  const registered = await fetchImpl(registration.url, {
    method: registration.method,
    headers: { ...registration.headers, authorization: `Bearer ${access.accessToken}` },
    body: registration.body,
  });
  if (!registered.ok) {
    throw new DigitalPostError(`e-Boks device registration failed with HTTP ${registered.status}.`);
  }
  let name: string | null = null;
  const profile = await fetchImpl(`${EBOKS_API_BASE}/user/profile`, {
    method: 'GET',
    headers: { authorization: `Bearer ${access.accessToken}`, accept: 'application/json' },
  });
  if (profile.ok) {
    const json = (await profile.json()) as { name?: unknown };
    name = typeof json.name === 'string' ? json.name : null;
  }
  const stored: StoredEboksDevice = { ...options.device, name, activated: true };
  await new EboksDeviceStore(options.paths).save(stored);
  return stored;
}

function mailUrl(path: string, query?: URLSearchParams): string {
  const url = new URL(`${EBOKS_API_BASE}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of query) url.searchParams.append(key, value);
  }
  return url.toString();
}

function rejectCprUserId(userId: string | undefined): void {
  if (userId && isCprShaped(userId)) {
    throw new DigitalPostError(
      'Refusing a CPR-shaped userId. Pass the share id from eboks.discover.',
    );
  }
}

function userQuery(userId?: string): URLSearchParams | undefined {
  rejectCprUserId(userId);
  if (!userId) return undefined;
  return new URLSearchParams({ userId });
}

function flattenFolders(nodes: unknown[], parentId: string | null): EboksFolder[] {
  const out: EboksFolder[] = [];
  for (const node of nodes) {
    const record = asRecord(node);
    const id = idString(record.id);
    if (!id) continue;
    const parent = asRecord(record.parent);
    out.push({
      id,
      name: stringOrNull(record.name),
      type: stringOrNull(record.type),
      parentId: idString(parent.id) || parentId,
    });
    const children = Array.isArray(record.folders) ? record.folders : [];
    out.push(...flattenFolders(children, id));
  }
  return out;
}

function toMessage(record: Record<string, unknown>, folderId: string): EboksMessage {
  const sender = asRecord(record.sender);
  const content = asRecord(record.content);
  const attachments = Array.isArray(record.attachments) ? record.attachments : [];
  const folder = asRecord(record.folder);
  return {
    id: idString(record.id),
    folderId: idString(record.folderId) || idString(folder.id) || folderId,
    subject: stringOrNull(record.subject) ?? stringOrNull(content.title),
    sender: stringOrNull(sender.name) ?? stringOrNull(record.sender),
    receivedAt: stringOrNull(record.received),
    unread: typeof record.unread === 'boolean' ? record.unread : null,
    bodyFile: toBodyFile(content),
    attachmentCount:
      typeof record.numberOfAttachments === 'number'
        ? record.numberOfAttachments
        : attachments.length,
    attachments: attachments.map((item) => toAttachment(asRecord(item))),
  };
}

function toAttachment(record: Record<string, unknown>): EboksAttachment {
  const content = asRecord(record.content);
  return {
    id: idString(record.id),
    filename:
      stringOrNull(record.name) ??
      stringOrNull(record.title) ??
      stringOrNull(content.title) ??
      extensionName(record) ??
      extensionName(content),
    mimeType: stringOrNull(record.mimeType) ?? stringOrNull(content.mimeType),
    size: fileSize(record.fileSize) ?? fileSize(content.fileSize),
  };
}

function extensionName(content: Record<string, unknown>): string | null {
  const ext = stringOrNull(content.fileExtension);
  return ext ? `letter.${ext}` : null;
}

function fileSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** e-Boks ids arrive as strings or numbers. */
function idString(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function toBodyFile(content: Record<string, unknown>): EboksBodyFile | null {
  const extension = stringOrNull(content.fileExtension)?.replace(/[^A-Za-z0-9]+/g, '') ?? null;
  const mimeType = stringOrNull(content.mimeType);
  const size = fileSize(content.fileSize);
  if (!extension && !mimeType && size == null) return null;
  return { filename: extension ? `letter.${extension}` : null, mimeType, size };
}

function expectArrayField(json: unknown, key: string, path: string): unknown[] {
  const value = asRecord(json)[key];
  if (!Array.isArray(value)) throw new UpstreamChangedError(path);
  return value;
}

function arrayField(json: unknown, key: string): unknown[] {
  const value = asRecord(json)[key];
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
