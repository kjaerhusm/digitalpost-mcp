import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { type DigitalPostPaths, ensurePrivateDir } from './config.ts';

/** Stable device id sent on the authorize URL, same role as the mobile app's deviceId. */
export async function loadOrCreateDeviceId(paths: DigitalPostPaths): Promise<string> {
  try {
    const existing = (await readFile(paths.deviceIdFile, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    // created below
  }
  await ensurePrivateDir(paths.dir);
  const id = randomBytes(16).toString('hex');
  await writeFile(paths.deviceIdFile, `${id}\n`, { mode: 0o600 });
  await chmod(paths.deviceIdFile, 0o600);
  return id;
}
