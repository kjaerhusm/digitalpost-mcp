/**
 * Public surface of the vendored MitID client.
 * See NOTICE.md for the MIT attribution to Casperjuel/aula-mcp.
 */

export { SessionCookieJar, type SessionCookieJarOptions } from './cookies.ts';
export {
  type AesGcmCiphertext,
  aesGcmDecrypt,
  aesGcmEncrypt,
  hmacSha256,
  pbkdf2Sha256,
  randomBase64Url,
  randomBytes,
  sha256,
} from './crypto.ts';
export { base64url } from './encoding.ts';
export { AuthError, HtmlParseError, RedirectLoopError } from './errors.ts';
export {
  extractAllAttr,
  extractAttr,
  extractFormAction,
  extractHiddenInputs,
  extractMetaRefreshUrl,
  extractText,
} from './html.ts';
export {
  type FollowOptions,
  type FollowResult,
  HttpClient,
  type HttpClientOptions,
  type HttpResponse,
  type RequestOptions,
  setOutboundGuard,
} from './http.ts';
export { consoleLogger, type Logger, silentLogger, stderrLogger } from './logger.ts';
export {
  type AppAuthCallbacks,
  type AppAuthLoopOptions,
  MitidAuthenticatorUnavailableError,
  type MitidAuxData,
  MitidClient,
  type MitidClientOptions,
  MitidError,
  MitidIdentityNotFoundError,
  MitidParallelSessionError,
  parseAuxResponse,
} from './mitid-client.ts';
export { mitidUrls } from './mitid-urls.ts';
export { challengeFromVerifier, generatePkce, type PkcePair } from './pkce.ts';
export { generateState } from './state.ts';
export { sanitizeLogMeta, sanitizeUrl } from './wire-tracer.ts';
