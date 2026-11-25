import {
  DigitalPostApi,
  DigitalPostError,
  type DigitalPostPaths,
  type PublicFolder,
  type PublicMailbox,
  pathsFromEnv,
  Session,
  TokenStore,
} from '@digitalpost/client';
import type { Logger } from '@digitalpost/mitid';

const MAILBOX_CACHE_MS = 5 * 60_000;
const FOLDER_CACHE_MS = 60_000;

export class DigitalPostContext {
  readonly paths: DigitalPostPaths;
  readonly store: TokenStore;
  readonly session: Session;
  readonly logger: Logger;
  private readonly now: () => number;
  private mailboxCache: { at: number; key: string; boxes: PublicMailbox[] } | null = null;
  private folderCache = new Map<string, { at: number; key: string; folders: PublicFolder[] }>();

  constructor(options?: { logger?: Logger; paths?: DigitalPostPaths; now?: () => number }) {
    this.paths = options?.paths ?? pathsFromEnv();
    this.store = new TokenStore({ paths: this.paths });
    this.session = new Session({ store: this.store });
    this.logger = options?.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.now = options?.now ?? Date.now;
  }

  api(): DigitalPostApi {
    return new DigitalPostApi({
      accessToken: () => this.session.accessToken(),
      refreshAccessToken: () => this.session.forceRefresh(),
    });
  }

  async mailboxes(): Promise<PublicMailbox[]> {
    const key = await this.cacheKey();
    const cached = this.mailboxCache;
    if (cached && cached.key === key && this.now() - cached.at < MAILBOX_CACHE_MS) {
      return cached.boxes;
    }
    const boxes = await this.api().listMailboxes();
    this.mailboxCache = { at: this.now(), key, boxes };
    return boxes;
  }

  /** Folder metadata, cached for one minute. File bytes are never cached. */
  async folders(mailboxId: string): Promise<PublicFolder[]> {
    const key = await this.cacheKey();
    const cached = this.folderCache.get(mailboxId);
    if (cached && cached.key === key && this.now() - cached.at < FOLDER_CACHE_MS) {
      return cached.folders;
    }
    const folders = await this.api().listFolders(mailboxId);
    this.folderCache.set(mailboxId, { at: this.now(), key, folders });
    return folders;
  }

  /** Username plus refresh token. A new login or a replaced token misses the cache. */
  private async cacheKey(): Promise<string> {
    const stored = await this.session.status();
    return `${stored?.status ?? 'none'}\n${stored?.username ?? ''}\n${stored?.tokens?.refreshToken ?? ''}`;
  }

  async resolveMailbox(mailboxId?: string): Promise<PublicMailbox> {
    const boxes = await this.mailboxes();
    if (mailboxId) {
      const found = boxes.find((box) => box.id === mailboxId);
      if (!found) throw new DigitalPostError(`No mailbox with id ${mailboxId}.`);
      return found;
    }
    const citizen = boxes.find((box) => box.ownerType === 'CITIZEN');
    const chosen = citizen ?? boxes[0];
    if (!chosen) throw new DigitalPostError('Digital Post returned no mailbox.');
    return chosen;
  }
}
