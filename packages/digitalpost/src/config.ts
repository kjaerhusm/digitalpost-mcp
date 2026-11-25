import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ENV } from './constants.ts';

export interface DigitalPostPaths {
  /** Config directory, mode 0700. */
  dir: string;
  tokenFile: string;
  keyFile: string;
  deviceIdFile: string;
  downloadDir: string;
}

export function configDir(): string {
  const fromEnv = process.env[ENV.dir];
  if (fromEnv?.trim()) return resolve(fromEnv);
  return join(homedir(), '.config', 'digitalpost-mcp');
}

export function pathsFromEnv(): DigitalPostPaths {
  const dir = configDir();
  const downloadFromEnv = process.env[ENV.downloadDir];
  return {
    dir,
    tokenFile: join(dir, 'tokens.enc'),
    keyFile: join(dir, '.key'),
    deviceIdFile: join(dir, 'device-id'),
    downloadDir: downloadFromEnv?.trim() ? resolve(downloadFromEnv) : join(dir, 'downloads'),
  };
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/** True for a Host or URL host that is loopback, with or without a port. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  if (value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]') {
    return true;
  }
  return /^(127\.0\.0\.1|localhost):\d+$/.test(value) || /^\[::1\]:\d+$/.test(value);
}

export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return isLoopbackHost(url.host);
  } catch {
    return false;
  }
}

export function loopbackHost(raw: string | undefined, fallback = '127.0.0.1'): string {
  const host = (raw ?? fallback).trim().toLowerCase();
  if (host === 'localhost') return '127.0.0.1';
  if (host === '127.0.0.1' || host === '::1') return host;
  throw new Error(`Refusing to bind ${raw}. digitalpost-mcp listens on 127.0.0.1 only.`);
}

export function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value === 'true';
}
