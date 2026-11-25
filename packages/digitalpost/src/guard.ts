import { setOutboundGuard } from '@digitalpost/mitid';
import { MAIL_API_BASE, MAIL_API_ORIGIN } from './constants.ts';
import { assertEboksMailRead } from './eboks-guard.ts';
import { ReadOnlyError } from './errors.ts';

/**
 * The mail API is GET-only in this program. Token refresh uses a different
 * origin (`digitalpost.dk`) and never goes through this function.
 */
export function isMailApiUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === MAIL_API_ORIGIN && parsed.pathname.startsWith('/apis/v1');
}

export function assertMailRead(method: string, url: string): void {
  if (!isMailApiUrl(url)) return;
  if (method.toUpperCase() !== 'GET') {
    throw new ReadOnlyError(
      `Refusing ${method.toUpperCase()} ${new URL(url).pathname}. This program only reads Digital Post (GET).`,
    );
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Fetch wrapper for the mail API. Non-GET methods throw before the network.
 */
export async function guardedMailFetch(
  fetchImpl: FetchLike,
  method: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  assertMailRead(method, url);
  if (!isMailApiUrl(url)) {
    throw new ReadOnlyError(`Refusing to call ${url} through the mail client.`);
  }
  const headers = new Headers(init.headers);
  return fetchImpl(url, { ...init, method: 'GET', headers });
}

setOutboundGuard((method, url) => {
  assertMailRead(method, url);
  assertEboksMailRead(method, url);
});

export function mailUrl(path: string, query?: URLSearchParams): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${MAIL_API_BASE}${suffix}`);
  if (query) {
    for (const [key, value] of query) url.searchParams.append(key, value);
  }
  return url.toString();
}
