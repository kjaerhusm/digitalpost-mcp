/**
 * Vendored from https://github.com/Casperjuel/aula-mcp (MIT), packages/aula-auth.
 * Copyright (c) 2026 Casper Juel. See packages/mitid/NOTICE.md.
 * Decoupled from Aula types: HttpClient, HttpResponse, SessionCookieJar, AuthError.
 */

/**
 * Base error for everything the auth package throws.
 * Subclass for distinct failure modes that callers should branch on.
 */

import { sanitizeUrl } from './wire-tracer.ts';

export class AuthError extends Error {
  override readonly name: string = 'AuthError';
  override readonly cause: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.cause = options?.cause;
  }
}

export class RedirectLoopError extends AuthError {
  override readonly name: string = 'RedirectLoopError';
  /** Sanitised — the URL we got stuck on may carry `?code=` or `?access_token=`,
   *  and this message ends up in the login log and in issue reports. */
  readonly lastUrl: string;
  constructor(
    public readonly hops: number,
    lastUrl: string,
  ) {
    const safeUrl = sanitizeUrl(lastUrl);
    super(`Exceeded ${hops} redirect hops; stuck at ${safeUrl}`);
    this.lastUrl = safeUrl;
  }
}

export class HtmlParseError extends AuthError {
  override readonly name: string = 'HtmlParseError';
  constructor(
    message: string,
    public readonly snippet?: string,
  ) {
    super(message);
  }
}
