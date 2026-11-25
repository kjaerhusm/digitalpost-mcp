import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertInsideDownloadDir, writeDownload } from './downloads.ts';

describe('download paths', () => {
  test('rejects a symlink that points outside the download directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'digitalpost-dl-'));
    const outside = await mkdtemp(join(tmpdir(), 'digitalpost-out-'));
    await writeFile(join(outside, 'secret.txt'), 'nope');
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, 'link'));
    await expect(assertInsideDownloadDir(root, 'link/secret.txt')).rejects.toThrow(/outside/);
    const saved = await assertInsideDownloadDir(root, 'letter.pdf');
    expect(saved.startsWith(root)).toBe(true);
  });

  test('a rejected path does not create directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'digitalpost-dl-'));
    const outside = '/tmp/evilprobe-digitalpost/a/b/x.pdf';
    await rm('/tmp/evilprobe-digitalpost', { recursive: true, force: true });
    await expect(assertInsideDownloadDir(root, outside)).rejects.toThrow(/outside/);
    await expect(stat('/tmp/evilprobe-digitalpost')).rejects.toThrow();
    await expect(assertInsideDownloadDir(root, 'a/b/x.pdf')).rejects.toThrow();
    await expect(stat(join(root, 'a'))).rejects.toThrow();
    const missing = join(tmpdir(), `digitalpost-missing-${Date.now()}`);
    await rm(missing, { recursive: true, force: true });
    await expect(assertInsideDownloadDir(missing, 'a/b/x.pdf')).rejects.toThrow();
    await expect(stat(missing)).rejects.toThrow();
  });

  test('two files with the same name keep distinct paths and contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'digitalpost-dl-'));
    const first = await writeDownload(root, new TextEncoder().encode('first letter'), 'brev.pdf');
    const second = await writeDownload(root, new TextEncoder().encode('second letter'), 'brev.pdf');
    expect(first).not.toBe(second);
    expect(first.endsWith('-brev.pdf')).toBe(true);
    expect(second.endsWith('-brev.pdf')).toBe(true);
    expect(await readFile(first, 'utf8')).toBe('first letter');
    expect(await readFile(second, 'utf8')).toBe('second letter');
  });
});
