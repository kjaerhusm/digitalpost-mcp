import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../../', import.meta.url).pathname;
const ALLOWED = new Set([
  'packages/mitid/src/http.ts',
  'packages/digitalpost/src/guarded-fetch.ts',
]);

describe('fetch allowlist', () => {
  test('fetch( appears only in the guarded HTTP entry points', () => {
    const files: string[] = [];
    walk(ROOT, files);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const source = stripTemplateLiterals(readFileSync(file, 'utf8'));
      if (/\bfetch\s*\(/.test(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

/** Browser code embedded in an HTML template is not a server-side fetch. */
function stripTemplateLiterals(source: string): string {
  return source.replace(/`(?:\\`|[^`])*`/gs, '``');
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path, out);
      continue;
    }
    if (path.endsWith('.ts') && !path.endsWith('.test.ts')) out.push(path);
  }
}
