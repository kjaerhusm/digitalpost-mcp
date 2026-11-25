import type { DigitalPostApi } from './api.ts';
import { ApiError } from './errors.ts';
import type { PublicFolder, PublicMailbox } from './redact.ts';

export interface MailboxSummary {
  mailboxId: string;
  ownerName: string | null;
  folders: Array<{
    id: string;
    name: string | null;
    folderType: string | null;
    totalElements: number | null;
  }>;
  foldersTruncated: boolean;
  senders: Array<{ sender: string; count: number }>;
  sampledMessages: number;
  note: string;
}

const FOLDER_CAP = 25;

/**
 * Folder totals come from `totalElements` on a one-row page. Sender counts
 * are only the newest 100 messages in the mailbox.
 */
export async function mailboxSummary(
  api: DigitalPostApi,
  mailbox: PublicMailbox,
  folders: PublicFolder[],
): Promise<MailboxSummary> {
  const selected = folders.slice(0, FOLDER_CAP);
  const folderRows = [];
  for (const folder of selected) {
    try {
      const page = await api.listMessages(mailbox.id, { folderId: folder.id, page: 0, size: 1 });
      folderRows.push({
        id: folder.id,
        name: folder.name,
        folderType: folder.folderType,
        totalElements: page.totalElements,
      });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) continue;
      throw error;
    }
  }
  const sample = await api.listMessages(mailbox.id, { page: 0, size: 100 });
  const counts = new Map<string, number>();
  for (const message of sample.messages) {
    const sender = message.sender?.trim() || 'Unknown sender';
    counts.set(sender, (counts.get(sender) ?? 0) + 1);
  }
  const senders = [...counts.entries()]
    .map(([sender, count]) => ({ sender, count }))
    .sort((a, b) => b.count - a.count || a.sender.localeCompare(b.sender));
  return {
    mailboxId: mailbox.id,
    ownerName: mailbox.ownerName,
    folders: folderRows,
    foldersTruncated: folders.length > selected.length,
    senders,
    sampledMessages: sample.messages.length,
    note: 'Sender counts use the newest 100 messages only. Folder totals are totalElements from the gateway. Unread is not available as a folder total.',
  };
}
