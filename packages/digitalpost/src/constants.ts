/**
 * Endpoints and the public OAuth client of the official e-Boks mobile app.
 *
 * The client id and secret identify the app, not a person. They are the same
 * for every install and are already published by independent clients
 * (chime-mu/ebox, dk/Net-Eboks). They are not a user credential.
 *
 * Mail is read from the state's view API. Token exchange uses the host the
 * mobile app uses (`digitalpost.dk`), which is a different origin from the
 * mail API on purpose: this package never POSTs to the mail API.
 */

export const AUTHORIZE_URL = 'https://gateway.digitalpost.dk/auth/oauth/authorize';
export const TOKEN_URL = 'https://digitalpost.dk/auth/oauth/token';
export const MAIL_API_ORIGIN = 'https://gateway.digitalpost.dk';
export const MAIL_API_BASE = `${MAIL_API_ORIGIN}/apis/v1`;
export const REDIRECT_URI = 'eboksdk://ngdpoidc/callback';
export const OAUTH_CLIENT_ID = 'e-boks-mobile';
/** Public app secret. See the file comment. The `%` is a literal character. */
export const OAUTH_CLIENT_SECRET = 'y0vKRKoVvqO%N3HBDK0T5bbzqo_eZsI0';
export const OAUTH_IDP = 'nemloginEboksRealm';
export const DEVICE_NAME = 'digitalpost-mcp';

export const ACCESS_TOKEN_SKEW_MS = 120_000;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
/** Not 7878: that is aula-mcp's HTTP port. */
export const DEFAULT_MCP_PORT = 8788;
/** Not 8099: that is aula-mcp's login port. */
export const DEFAULT_LOGIN_PORT = 8098;
export const REFRESH_FAILURES_BEFORE_LOGIN_REQUIRED = 3;

export const EBOKS_USER_TOKEN_URL =
  'https://digitalpostproxy.e-boks.dk/loginservice/v2/connect/usertoken';
export const EBOKS_TOKEN_URL = 'https://oauth-dk.e-boks.com/1/connect/token';
export const EBOKS_API_ORIGIN = 'https://mobile-api-dk.e-boks.com';
export const EBOKS_API_BASE = `${EBOKS_API_ORIGIN}/2`;
/** Public client of the official e-Boks app. Identifies the app, not a person. */
export const EBOKS_CLIENT_ID = 'MobileApp-Short-Custom-id';
export const EBOKS_CLIENT_SECRET = 'QmaENW6MeYwwjzF5';
/** e-Boks access tokens last about five minutes. Refresh a little before that. */
export const EBOKS_TOKEN_SKEW_MS = 30_000;

export const ENV = {
  dir: 'DIGITALPOST_DIR',
  key: 'DIGITALPOST_KEY',
  mcpPort: 'DIGITALPOST_MCP_PORT',
  mcpHost: 'DIGITALPOST_MCP_HOST',
  loginPort: 'DIGITALPOST_LOGIN_PORT',
  loginHost: 'DIGITALPOST_LOGIN_HOST',
  downloadDir: 'DIGITALPOST_DOWNLOAD_DIR',
  log: 'DIGITALPOST_LOG',
  identity: 'DIGITALPOST_IDENTITY',
  loginTrace: 'DIGITALPOST_LOGIN_TRACE',
  eboks: 'DIGITALPOST_EBOKS',
  renewInterval: 'DIGITALPOST_RENEW_INTERVAL_MS',
} as const;
