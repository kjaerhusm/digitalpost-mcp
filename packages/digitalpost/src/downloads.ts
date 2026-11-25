import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { ensurePrivateDir } from './config.ts';
import { DigitalPostError } from './errors.ts';

export async function writeDownload(
  downloadDir: string,
  bytes: Uint8Array,
  filename: string,
): Promise<string> {
  await ensurePrivateDir(downloadDir);
  await mkdir(downloadDir, { recursive: true, mode: 0o700 });
  const safe = safeFilename(filename);
  const rootReal = await realpath(downloadDir);
  const stamp = Date.now();
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = attempt === 0 ? `${stamp}-${safe}` : `${stamp}-${attempt}-${safe}`;
    const target = join(rootReal, name);
    if (!isInside(rootReal, target)) {
      throw new DigitalPostError(
        'Refusing to read or write a file outside the download directory.',
      );
    }
    try {
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      return target;
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
    }
  }
  throw new DigitalPostError('Could not find a free name in the download directory.');
}

/** Read-path check. Does not create the download directory or any parent of `candidate`. */
export async function assertInsideDownloadDir(
  downloadDir: string,
  candidate: string,
): Promise<string> {
  return resolveInside(downloadDir, candidate, { create: false });
}

/**
 * Resolve `candidate` against the download directory and follow symlinks.
 * The lexical path is checked before any directory is created. `create` is
 * only for a write whose parent is already inside the directory.
 */
export async function resolveInside(
  root: string,
  candidate: string,
  options: { create?: boolean } = {},
): Promise<string> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch (error) {
    if (isNotFound(error)) {
      throw new DigitalPostError('The download directory does not exist.');
    }
    throw error;
  }
  const target = resolve(rootReal, candidate);
  if (!isInside(rootReal, target)) {
    throw new DigitalPostError('Refusing to read or write a file outside the download directory.');
  }
  const parent = dirname(target);
  if (!isInside(rootReal, parent)) {
    throw new DigitalPostError('Refusing to read or write a file outside the download directory.');
  }

  let parentReal: string;
  try {
    parentReal = await realpath(parent);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (!options.create) {
      throw new DigitalPostError('That file is not in the download directory.');
    }
    await mkdir(parent, { recursive: true, mode: 0o700 });
    parentReal = await realpath(parent);
  }
  if (!isInside(rootReal, parentReal)) {
    throw new DigitalPostError('Refusing to read or write a file outside the download directory.');
  }

  const name = basename(target);
  try {
    const finalReal = await realpath(target);
    if (!isInside(rootReal, finalReal)) {
      throw new DigitalPostError(
        'Refusing to read or write a file outside the download directory.',
      );
    }
    return finalReal;
  } catch (error) {
    if (error instanceof DigitalPostError) throw error;
    if (!isNotFound(error)) throw error;
    const joined = join(parentReal, name);
    if (!isInside(rootReal, joined)) {
      throw new DigitalPostError(
        'Refusing to read or write a file outside the download directory.',
      );
    }
    return joined;
  }
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

export function safeFilename(name: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  const trimmed = base.replace(/^\.+/, '').slice(0, 120);
  return trimmed || 'document.bin';
}

function isNotFound(error: unknown): boolean {
  return isCode(error, 'ENOENT');
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === code
  );
}
