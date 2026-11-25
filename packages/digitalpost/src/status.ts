import { eboksEnabled } from './eboks-auth.ts';
import type { PublicMailbox } from './redact.ts';
import type { Session } from './session.ts';

export const MAIL_READ_NOTE =
  'Digital Post never marks read; e-Boks content download marks the e-Boks letter read.';

export interface AccountStatus {
  loggedIn: boolean;
  status: 'ok' | 'login_required' | 'anonymous';
  username: string | null;
  accessExpiresAt: string | null;
  lastRenewAt: string | null;
  refreshFailures: number;
  mailboxes: PublicMailbox[];
  eboksRegistered: boolean;
  /** False when the e-Boks content tools are enabled, because those mark a letter read. */
  readOnly: boolean;
  note: string;
}

/** Login health for a tool or CLI. Tokens are not copied into the result. */
export async function readAccountStatus(options: {
  session: Session;
  listMailboxes: () => Promise<PublicMailbox[]>;
  eboksRegistered: boolean;
  /** When omitted, follows DIGITALPOST_EBOKS. Content tools are what mark a letter read. */
  eboksContentEnabled?: boolean;
}): Promise<AccountStatus> {
  const readOnly = !(options.eboksContentEnabled ?? eboksEnabled());
  const stored = await options.session.status();
  const lastRenewAt =
    stored?.lastRenewAt != null
      ? new Date(stored.lastRenewAt).toISOString()
      : stored?.status === 'ok' && stored.savedAt
        ? new Date(stored.savedAt).toISOString()
        : null;
  if (stored?.status !== 'ok' || !stored.tokens) {
    return {
      loggedIn: false,
      status: stored?.status ?? 'anonymous',
      username: stored?.username ?? null,
      accessExpiresAt: null,
      lastRenewAt,
      refreshFailures: stored?.refreshFailures ?? 0,
      mailboxes: [],
      eboksRegistered: options.eboksRegistered,
      readOnly,
      note: MAIL_READ_NOTE,
    };
  }
  return {
    loggedIn: true,
    status: 'ok',
    username: stored.username,
    accessExpiresAt: new Date(stored.tokens.expiresAt).toISOString(),
    lastRenewAt,
    refreshFailures: stored.refreshFailures ?? 0,
    mailboxes: await options.listMailboxes(),
    eboksRegistered: options.eboksRegistered,
    readOnly,
    note: MAIL_READ_NOTE,
  };
}
