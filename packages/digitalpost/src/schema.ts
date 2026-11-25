import { UpstreamChangedError } from './errors.ts';

/**
 * Checks the fields this program reads. Extra fields are ignored. A wrong
 * type fails the whole response. The raw JSON is never copied into the error.
 */

export function parseMailboxList(json: unknown, path: string): Record<string, unknown>[] {
  const record = expectRecord(json, path);
  return expectArray(record.mailboxes, path, 'mailboxes').map((item, index) => {
    const mailbox = expectRecord(item, path);
    expectString(mailbox.id, path, `mailboxes[${index}].id`);
    return mailbox;
  });
}

export function parseFolderList(json: unknown, path: string): Record<string, unknown>[] {
  if (Array.isArray(json)) return json.map((item) => expectRecord(item, path));
  const record = expectRecord(json, path);
  return expectArray(record.folders, path, 'folders').map((item) => expectRecord(item, path));
}

export interface ParsedMessagePage {
  messages: Record<string, unknown>[];
  totalElements: number | null;
  totalPages: number | null;
}

export function parseMessageList(json: unknown, path: string): ParsedMessagePage {
  const record = expectRecord(json, path);
  const messages = record.messages ?? record.results;
  return {
    messages: expectArray(messages, path, 'messages').map((item, index) =>
      parseMessage(item, path, `messages[${index}]`),
    ),
    totalElements: expectNumberOrNull(record.totalElements, path, 'totalElements'),
    totalPages: expectNumberOrNull(record.totalPages, path, 'totalPages'),
  };
}

export function parseMessage(
  json: unknown,
  path: string,
  label = 'message',
): Record<string, unknown> {
  const record = expectRecord(json, path);
  expectString(record.id, path, `${label}.id`);
  expectStringOrNull(record.label, path, `${label}.label`);
  expectBooleanOrNull(record.read, path, `${label}.read`);
  expectStringOrNull(record.receivedDateTime, path, `${label}.receivedDateTime`);
  expectStringOrNull(record.replyByDateTime, path, `${label}.replyByDateTime`);
  if (record.documents !== undefined) {
    const documents = expectArray(record.documents, path, `${label}.documents`);
    for (const [index, document] of documents.entries()) {
      const doc = expectRecord(document, path);
      if (doc.files !== undefined)
        expectArray(doc.files, path, `${label}.documents[${index}].files`);
    }
  }
  return record;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpstreamChangedError(path);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, path: string, label: string): unknown[] {
  if (!Array.isArray(value)) throw new UpstreamChangedError(`${path} (${label})`);
  return value;
}

function expectString(value: unknown, path: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new UpstreamChangedError(`${path} (${label})`);
  }
}

function expectStringOrNull(value: unknown, path: string, label: string): void {
  if (value == null) return;
  if (typeof value !== 'string') throw new UpstreamChangedError(`${path} (${label})`);
}

function expectBooleanOrNull(value: unknown, path: string, label: string): void {
  if (value == null) return;
  if (typeof value !== 'boolean') throw new UpstreamChangedError(`${path} (${label})`);
}

function expectNumberOrNull(value: unknown, path: string, label: string): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UpstreamChangedError(`${path} (${label})`);
  }
  return value;
}
