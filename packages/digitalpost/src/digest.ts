import type { DigitalPostApi } from './api.ts';
import { DATES_NOTE, type DetectedDate, datesFromLetter } from './dates.ts';
import { ApiError, LoginRequiredError, RateLimitedError, UpstreamChangedError } from './errors.ts';
import { extractPdfText } from './pdf.ts';
import type { PublicMessage } from './redact.ts';
import { compareInstants } from './time.ts';

export interface ListNewSinceInput {
  since: string;
  mailboxId?: string;
  folderId?: string;
  unread?: boolean;
  maxPages?: number;
}

/** One list page is 100 letters, so the default scan is 300 letters per mailbox. */
export const LIST_NEW_SINCE_PAGE_SIZE = 100;
export const LIST_NEW_SINCE_DEFAULT_PAGES = 3;
export const LIST_NEW_SINCE_MAX_PAGES = 10;

export function listNewSincePageLimit(maxPages: number | undefined): number {
  if (maxPages == null || !Number.isFinite(maxPages) || maxPages < 1) {
    return LIST_NEW_SINCE_DEFAULT_PAGES;
  }
  return Math.min(Math.floor(maxPages), LIST_NEW_SINCE_MAX_PAGES);
}

/** Pages newest-first until a raw page is older than `since` or the mailbox ends. */
export async function listNewSince(
  api: DigitalPostApi,
  mailboxIds: string[],
  input: ListNewSinceInput,
): Promise<PublicMessage[]> {
  const maxPages = listNewSincePageLimit(input.maxPages);
  const collected: PublicMessage[] = [];
  for (const mailboxId of mailboxIds) {
    for (let page = 0; page < maxPages; page++) {
      const batch = await api.listMessages(mailboxId, {
        page,
        size: LIST_NEW_SINCE_PAGE_SIZE,
        since: input.since,
        ...(input.folderId ? { folderId: input.folderId } : {}),
        ...(input.unread ? { unread: true } : {}),
      });
      collected.push(
        ...batch.messages.map((message) => ({
          ...message,
          mailboxId: message.mailboxId || mailboxId,
        })),
      );
      const finished =
        batch.rawCount === 0 ||
        batch.rawCount < LIST_NEW_SINCE_PAGE_SIZE ||
        (batch.totalPages != null && page + 1 >= batch.totalPages);
      const older =
        batch.oldestReceivedAt != null && compareInstants(batch.oldestReceivedAt, input.since) < 0;
      if (finished || older) break;
    }
  }
  collected.sort((a, b) => compareInstants(b.receivedAt ?? '', a.receivedAt ?? ''));
  return collected;
}

export interface DigestMessage {
  id: string;
  mailboxId: string | null;
  sender: string | null;
  subject: string | null;
  receivedAt: string | null;
  unread: boolean | null;
  officialReplyBy: string | null;
  detectedDates: DetectedDate[];
  pdfTextUsed: boolean;
}

export interface DigestMailbox {
  mailboxId: string;
  ownerName: string | null;
  count: number;
  messages: DigestMessage[];
}

export interface Digest {
  since: string;
  heuristic: true;
  note: string;
  mailboxes: DigestMailbox[];
}

const DIGEST_NOTE =
  `${DATES_NOTE} PDF text is read only for Digital Post, where downloading a file does not mark the letter read. ` +
  'This digest does not download e-Boks content.';

/**
 * New letters grouped by mailbox. Subject dates are always parsed. PDF text
 * is optional and capped, and only through the Digital Post file GET.
 */
export async function buildDigest(
  api: DigitalPostApi,
  mailboxes: Array<{ id: string; ownerName: string | null }>,
  input: ListNewSinceInput & { includePdf?: boolean; pdfLimit?: number },
): Promise<Digest> {
  const messages = await listNewSince(
    api,
    mailboxes.map((box) => box.id),
    input,
  );
  const includePdf = input.includePdf !== false;
  let pdfsLeft = includePdf ? Math.min(input.pdfLimit ?? 3, 8) : 0;
  const enriched: Array<{ message: PublicMessage; pdfText: string | null }> = [];
  for (const message of messages) {
    let pdfText: string | null = null;
    if (pdfsLeft > 0 && firstPdf(message)) {
      pdfsLeft -= 1;
      pdfText = await readFirstPdf(api, message);
    }
    enriched.push({ message, pdfText });
  }
  const names = new Map(mailboxes.map((box) => [box.id, box.ownerName]));
  const groups = new Map<string, DigestMessage[]>();
  for (const item of enriched) {
    const mailboxId = item.message.mailboxId ?? 'unknown';
    const list = groups.get(mailboxId) ?? [];
    list.push(toDigestMessage(item.message, item.pdfText));
    groups.set(mailboxId, list);
  }
  const orderedIds = [
    ...mailboxes.map((box) => box.id).filter((id) => groups.has(id)),
    ...[...groups.keys()].filter((id) => !names.has(id)),
  ];
  return {
    since: input.since,
    heuristic: true,
    note: DIGEST_NOTE,
    mailboxes: orderedIds.map((id) => ({
      mailboxId: id,
      ownerName: names.get(id) ?? null,
      count: groups.get(id)?.length ?? 0,
      messages: groups.get(id) ?? [],
    })),
  };
}

export function subjectDates(message: PublicMessage): DetectedDate[] {
  return datesFromLetter({
    subject: message.subject,
    receivedAt: message.receivedAt,
    replyBy: message.replyBy,
  });
}

function toDigestMessage(message: PublicMessage, pdfText: string | null): DigestMessage {
  return {
    id: message.id,
    mailboxId: message.mailboxId,
    sender: message.sender,
    subject: message.subject,
    receivedAt: message.receivedAt,
    unread: message.read == null ? null : message.read === false,
    officialReplyBy: message.replyBy,
    detectedDates: datesFromLetter({
      subject: message.subject,
      receivedAt: message.receivedAt,
      replyBy: message.replyBy,
      pdfText,
    }),
    pdfTextUsed: pdfText != null,
  };
}

function firstPdf(message: PublicMessage): { documentId: string; fileId: string } | null {
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

async function readFirstPdf(api: DigitalPostApi, message: PublicMessage): Promise<string | null> {
  const file = firstPdf(message);
  if (!file || !message.mailboxId) return null;
  try {
    const downloaded = await api.getFileContent(
      message.mailboxId,
      message.id,
      file.documentId,
      file.fileId,
    );
    const extracted = await extractPdfText(downloaded.bytes);
    return extracted.text;
  } catch (error) {
    if (
      error instanceof LoginRequiredError ||
      error instanceof RateLimitedError ||
      error instanceof UpstreamChangedError
    ) {
      throw error;
    }
    if (error instanceof ApiError && error.status !== 404) throw error;
    return null;
  }
}
