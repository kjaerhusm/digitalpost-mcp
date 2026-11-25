import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type DigitalPostPaths, ensurePrivateDir } from './config.ts';
import { DigitalPostError } from './errors.ts';
import { TokenStore } from './token-store.ts';

export interface StoredEboksDevice {
  version: 1;
  id: string;
  /** PKCS#8 PEM. Never returned from tools. */
  privateKeyPem: string;
  name: string | null;
  activated: boolean;
}

export function eboksDevicePath(paths: DigitalPostPaths): string {
  return join(paths.dir, 'eboks-device.enc');
}

/** Base64 of the DER SubjectPublicKeyInfo, the form e-Boks stores on the device. */
export function publicKeySpkiBase64(privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(der).toString('base64');
}

export function generateEboksDevice(): StoredEboksDevice {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return {
    version: 1,
    id: randomUUID(),
    privateKeyPem: typeof pem === 'string' ? pem : pem.toString('utf8'),
    name: null,
    activated: false,
  };
}

export class EboksDeviceStore {
  constructor(private readonly paths: DigitalPostPaths) {}

  async load(): Promise<StoredEboksDevice | null> {
    const file = eboksDevicePath(this.paths);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new DigitalPostError('Could not read the e-Boks device file.', { cause: error });
    }
    const store = new TokenStore({ paths: this.paths });
    const parsed = (await store.openJson(raw)) as StoredEboksDevice;
    if (parsed.version !== 1 || !parsed.id || !parsed.privateKeyPem) {
      throw new DigitalPostError('The e-Boks device file is not a device registration.');
    }
    return parsed;
  }

  async save(device: StoredEboksDevice): Promise<void> {
    await ensurePrivateDir(this.paths.dir);
    const store = new TokenStore({ paths: this.paths });
    const sealed = await store.sealJson(device);
    const file = eboksDevicePath(this.paths);
    const partial = `${file}.${randomUUID()}.part`;
    await writeFile(partial, sealed, { mode: 0o600 });
    await chmod(partial, 0o600);
    await rename(partial, file);
    await chmod(file, 0o600);
    await rm(partial, { force: true });
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
