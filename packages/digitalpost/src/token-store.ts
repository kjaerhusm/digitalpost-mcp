import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { aesGcmDecrypt, aesGcmEncrypt } from '@digitalpost/mitid';
import { type DigitalPostPaths, ensurePrivateDir } from './config.ts';
import { ENV } from './constants.ts';
import { DigitalPostError } from './errors.ts';
import type { TokenSet } from './oauth.ts';

export type LoginStatus = 'ok' | 'login_required';

export interface StoredLogin {
  version: 1;
  status: LoginStatus;
  /** MitID username used for the last successful login. Not a CPR. */
  username: string | null;
  tokens?: TokenSet;
  savedAt: number;
  /** Last successful login or token refresh. Not updated by a failed refresh. */
  lastRenewAt?: number;
  /** Transient refresh failures since the last success. Not a reason to drop the token. */
  refreshFailures?: number;
}

interface Envelope {
  version: 1;
  alg: 'aes-256-gcm';
  iv: string;
  ct: string;
  tag: string;
}

export interface TokenStoreOptions {
  paths: DigitalPostPaths;
  /** 32-byte key. Wins over the env var and the key file. */
  key?: Buffer;
  env?: NodeJS.ProcessEnv;
}

export class TokenStore {
  private readonly paths: DigitalPostPaths;
  private readonly explicitKey?: Buffer;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: TokenStoreOptions) {
    this.paths = options.paths;
    if (options.key) this.explicitKey = options.key;
    this.env = options.env ?? process.env;
  }

  async load(): Promise<StoredLogin | null> {
    let raw: string;
    try {
      raw = await readFile(this.paths.tokenFile, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new DigitalPostError('Could not read the token file.', { cause: error });
    }
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch (error) {
      throw new DigitalPostError('The token file is not valid JSON.', { cause: error });
    }
    if (envelope.version !== 1 || envelope.alg !== 'aes-256-gcm') {
      throw new DigitalPostError('The token file uses an unsupported format.');
    }
    const key = await this.resolveKey(false);
    let plaintext: Buffer;
    try {
      plaintext = aesGcmDecrypt(
        key,
        Buffer.from(envelope.iv, 'base64'),
        Buffer.from(envelope.ct, 'base64'),
        Buffer.from(envelope.tag, 'base64'),
      );
    } catch (error) {
      throw new DigitalPostError(
        'Could not decrypt the token file. The key does not match, or the file is damaged.',
        { cause: error },
      );
    }
    const parsed = JSON.parse(plaintext.toString('utf8')) as StoredLogin;
    if (parsed.version !== 1) throw new DigitalPostError('Unsupported stored login version.');
    return parsed;
  }

  async save(record: StoredLogin): Promise<void> {
    await ensurePrivateDir(this.paths.dir);
    const key = await this.resolveKey(true);
    const iv = randomBytes(12);
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, Buffer.from(JSON.stringify(record), 'utf8'));
    const envelope: Envelope = {
      version: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      ct: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
    const partial = `${this.paths.tokenFile}.${randomBytes(6).toString('hex')}.part`;
    await mkdir(dirname(this.paths.tokenFile), { recursive: true, mode: 0o700 });
    try {
      if (await exists(this.paths.tokenFile)) {
        await copyFile(this.paths.tokenFile, `${this.paths.tokenFile}.bak`);
        await chmod(`${this.paths.tokenFile}.bak`, 0o600);
      }
      await writeFile(partial, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
      await chmod(partial, 0o600);
      await rename(partial, this.paths.tokenFile);
      await chmod(this.paths.tokenFile, 0o600);
    } finally {
      await rm(partial, { force: true });
    }
  }

  async clear(): Promise<void> {
    await rm(this.paths.tokenFile, { force: true });
  }

  /** Encrypt an arbitrary JSON value with the same key as the token file. */
  async sealJson(value: unknown): Promise<string> {
    const key = await this.resolveKey(true);
    const iv = randomBytes(12);
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, Buffer.from(JSON.stringify(value), 'utf8'));
    const envelope: Envelope = {
      version: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      ct: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
    return JSON.stringify(envelope);
  }

  /** Decrypt a value produced by `sealJson`. */
  async openJson(raw: string): Promise<unknown> {
    const envelope = JSON.parse(raw) as Envelope;
    if (envelope.version !== 1 || envelope.alg !== 'aes-256-gcm') {
      throw new DigitalPostError('The encrypted file uses an unsupported format.');
    }
    const key = await this.resolveKey(false);
    let plaintext: Buffer;
    try {
      plaintext = aesGcmDecrypt(
        key,
        Buffer.from(envelope.iv, 'base64'),
        Buffer.from(envelope.ct, 'base64'),
        Buffer.from(envelope.tag, 'base64'),
      );
    } catch (error) {
      throw new DigitalPostError('Could not decrypt the file.', { cause: error });
    }
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  }

  /**
   * Marks the login unusable without deleting the refresh token. The previous
   * file is copied to `tokens.enc.bak` by `save`.
   */
  async markLoginRequired(username: string | null): Promise<void> {
    const current = await this.load().catch(() => null);
    await this.save({
      version: 1,
      status: 'login_required',
      username: username ?? current?.username ?? null,
      ...(current?.tokens ? { tokens: current.tokens } : {}),
      savedAt: Date.now(),
      ...(current?.lastRenewAt !== undefined ? { lastRenewAt: current.lastRenewAt } : {}),
      refreshFailures: current?.refreshFailures ?? 0,
    });
  }

  /** Counts a transient refresh failure and keeps the refresh token. */
  async noteRefreshFailure(username: string | null): Promise<number> {
    const current = await this.load();
    const failures = (current?.refreshFailures ?? 0) + 1;
    await this.save({
      version: 1,
      status: current?.status ?? 'ok',
      username: username ?? current?.username ?? null,
      ...(current?.tokens ? { tokens: current.tokens } : {}),
      savedAt: Date.now(),
      ...(current?.lastRenewAt !== undefined ? { lastRenewAt: current.lastRenewAt } : {}),
      refreshFailures: failures,
    });
    return failures;
  }

  private async resolveKey(create: boolean): Promise<Buffer> {
    if (this.explicitKey) {
      if (this.explicitKey.length !== 32) {
        throw new DigitalPostError('The encryption key must be 32 bytes.');
      }
      return this.explicitKey;
    }
    const fromEnv = this.env[ENV.key];
    if (fromEnv?.trim()) {
      const key = decodeKey(fromEnv.trim());
      if (key.length !== 32) throw new DigitalPostError(`${ENV.key} must decode to 32 bytes.`);
      return key;
    }
    try {
      const existing = await readFile(this.paths.keyFile);
      if (existing.length !== 32) throw new DigitalPostError('The key file is not 32 bytes.');
      return existing;
    } catch (error) {
      if (!isNotFound(error)) {
        throw new DigitalPostError('Could not read the key file.', { cause: error });
      }
      if (!create)
        throw new DigitalPostError('No encryption key is available to read the token file.');
      await ensurePrivateDir(this.paths.dir);
      const created = randomBytes(32);
      try {
        await writeFile(this.paths.keyFile, created, { flag: 'wx', mode: 0o600 });
        await chmod(this.paths.keyFile, 0o600);
        return created;
      } catch (createError) {
        if (!isCode(createError, 'EEXIST')) {
          throw new DigitalPostError('Could not create the key file.', { cause: createError });
        }
        const raced = await readFile(this.paths.keyFile);
        if (raced.length !== 32) throw new DigitalPostError('The key file is not 32 bytes.');
        return raced;
      }
    }
  }
}

function decodeKey(value: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  return Buffer.from(value, 'base64');
}

function isNotFound(error: unknown): boolean {
  return isCode(error, 'ENOENT');
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === code
  );
}
