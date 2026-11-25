import { EBOKS_API_ORIGIN } from './constants.ts';
import { ReadOnlyError } from './errors.ts';

/** Mail routes on the e-Boks mobile API. Device registration lives under `/2/user` and is not this. */
export function isEboksMailUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === EBOKS_API_ORIGIN && parsed.pathname.startsWith('/2/mail');
}

const MESSAGE_CONTENT = /^\/2\/mail\/folders\/[^/]+\/messages\/[^/]+\/content$/;
const ATTACHMENT_CONTENT =
  /^\/2\/mail\/folders\/[^/]+\/messages\/[^/]+\/attachment\/[^/]+\/content$/;

/**
 * GET of one message body or one attachment. e-Boks marks that letter read.
 * Any other path ending in `/content` stays refused.
 */
export function isEboksContentPath(pathname: string): boolean {
  return MESSAGE_CONTENT.test(pathname) || ATTACHMENT_CONTENT.test(pathname);
}

export function assertEboksMailRead(method: string, url: string): void {
  if (!isEboksMailUrl(url)) return;
  const pathname = normalizedMailPath(url);
  const verb = method.toUpperCase();
  if (verb !== 'GET') {
    throw new ReadOnlyError(`Refusing ${verb} ${pathname}. e-Boks mail is read with GET only.`);
  }
  if (pathname.includes('/content') && !isEboksContentPath(pathname)) {
    throw new ReadOnlyError(
      `Refusing GET ${pathname}. Only one message or one attachment content GET is allowed.`,
    );
  }
}

function normalizedMailPath(url: string): string {
  const raw = new URL(url).pathname;
  let pathname = raw;
  try {
    pathname = decodeURIComponent(raw);
  } catch {
    pathname = raw;
  }
  const trimmed = pathname.replace(/\/+$/, '');
  return (trimmed.length > 0 ? trimmed : '/').toLowerCase();
}
