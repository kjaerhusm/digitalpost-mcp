/**
 * Vendored from https://github.com/Casperjuel/aula-mcp (MIT), packages/aula-auth.
 * Copyright (c) 2026 Casper Juel. See packages/mitid/NOTICE.md.
 * Decoupled from Aula types: HttpClient, HttpResponse, SessionCookieJar, AuthError.
 */

/** OAuth `state` token — opaque random URL-safe string. */

import { randomBase64Url } from './crypto.ts';

export function generateState(bytes: number = 32): string {
  return randomBase64Url(bytes);
}
