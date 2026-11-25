/**
 * Shapes returned to MCP clients and the CLI.
 * Identity numbers (CPR / CVR on the recipient) are never copied out.
 */

/** Ten digits, or six digits, one dash, and four digits. */
const CPR_SHAPED = /^\d{6}-?\d{4}$/;

export interface PublicMailbox {
  id: string;
  ownerType: string | null;
  ownerName: string | null;
}

export interface PublicFile {
  id: string;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
}

export interface PublicDocument {
  id: string;
  label: string | null;
  documentType: string | null;
  files: PublicFile[];
}

export interface PublicMessage {
  id: string;
  mailboxId: string | null;
  folderId: string | null;
  subject: string | null;
  sender: string | null;
  receivedAt: string | null;
  read: boolean | null;
  replyBy: string | null;
  legallyNotified: boolean | null;
  documents: PublicDocument[];
}

export interface PublicFolder {
  id: string;
  name: string | null;
  folderType: string | null;
  parentFolderId: string | null;
}

interface RawFile {
  id?: string;
  filename?: string;
  encodingFormat?: string;
  fileSize?: number;
}

interface RawDocument {
  id?: string;
  label?: string;
  documentType?: string;
  files?: RawFile[];
}

interface RawMessage {
  id?: string;
  mailboxId?: string;
  folderId?: string;
  label?: string;
  receivedDateTime?: string;
  createdDateTime?: string;
  messageDateTime?: string;
  read?: boolean;
  replyByDateTime?: string;
  legallyNotified?: boolean;
  sender?: { label?: string; senderId?: string };
  recipient?: { recipientId?: string; label?: string };
  documents?: RawDocument[];
}

export function isCprShaped(value: string): boolean {
  return CPR_SHAPED.test(value.trim());
}

export function toPublicMailbox(raw: {
  id?: string;
  ownerType?: string;
  ownerName?: string;
  ownerIdentityId?: string;
}): PublicMailbox {
  return {
    id: raw.id ?? '',
    ownerType: raw.ownerType ?? null,
    ownerName: raw.ownerName ?? null,
  };
}

export function toPublicMessage(raw: RawMessage): PublicMessage {
  return {
    id: raw.id ?? '',
    mailboxId: raw.mailboxId ?? null,
    folderId: raw.folderId ?? null,
    subject: raw.label ?? null,
    sender: raw.sender?.label ?? null,
    receivedAt: raw.receivedDateTime ?? raw.messageDateTime ?? raw.createdDateTime ?? null,
    read: typeof raw.read === 'boolean' ? raw.read : null,
    replyBy: raw.replyByDateTime ?? null,
    legallyNotified: typeof raw.legallyNotified === 'boolean' ? raw.legallyNotified : null,
    documents: (raw.documents ?? []).map(toPublicDocument),
  };
}

function toPublicDocument(raw: RawDocument): PublicDocument {
  return {
    id: raw.id ?? '',
    label: raw.label ?? null,
    documentType: raw.documentType ?? null,
    files: (raw.files ?? []).map((file) => ({
      id: file.id ?? '',
      filename: file.filename ?? null,
      mimeType: file.encodingFormat ?? null,
      size: typeof file.fileSize === 'number' ? file.fileSize : null,
    })),
  };
}

export function toPublicFolder(raw: {
  id?: string;
  name?: string;
  folderType?: string;
  parentFolderId?: string | null;
}): PublicFolder {
  return {
    id: raw.id ?? '',
    name: raw.name ?? null,
    folderType: raw.folderType ?? null,
    parentFolderId: raw.parentFolderId ?? null,
  };
}

/** Drop a string if it is CPR-shaped (10 digits, optional dash). Used by tests and defensive copies. */
export function redactCpr(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isCprShaped(value)) return null;
  return value;
}
