import { DigitalPostError } from './errors.ts';

export type CursorKind = 'page' | 'search';

export function encodeCursor(kind: CursorKind, payload: unknown): string {
  const prefix = kind === 'page' ? 'p1' : 's1';
  return `${prefix}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

export function decodeCursor(kind: CursorKind, cursor: string): unknown {
  const prefix = kind === 'page' ? 'p1.' : 's1.';
  if (!cursor.startsWith(prefix)) {
    throw new DigitalPostError('That cursor is not valid. Start again without one.');
  }
  try {
    const json = Buffer.from(cursor.slice(prefix.length), 'base64url').toString('utf8');
    return JSON.parse(json) as unknown;
  } catch {
    throw new DigitalPostError('That cursor is not valid. Start again without one.');
  }
}
