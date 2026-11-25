import { Buffer } from 'node:buffer';
import {
  AUTHORIZE_URL,
  DEVICE_NAME,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_IDP,
  REDIRECT_URI,
  TOKEN_URL,
} from './constants.ts';
import { DigitalPostError } from './errors.ts';

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch milliseconds when the access token should be treated as expired. */
  expiresAt: number;
  tokenType: string;
}

export interface AuthorizeUrlInput {
  state: string;
  nonce: string;
  codeChallenge: string;
  deviceId: string;
  deviceName?: string;
}

/** OAuth authorize URL. The client secret is intentionally absent. */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const query = new URLSearchParams({
    idp: OAUTH_IDP,
    client_id: OAUTH_CLIENT_ID,
    response_type: 'code',
    scope: 'openid',
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    response_mode: 'query',
    nonce: input.nonce,
    redirect_uri: REDIRECT_URI,
    deviceName: input.deviceName ?? DEVICE_NAME,
    deviceId: input.deviceId,
  });
  return `${AUTHORIZE_URL}?${query.toString()}`;
}

export interface PreparedRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body?: string;
}

function basicAuthorization(): string {
  const raw = `${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

/**
 * Authorization-code exchange, matching the e-Boks app: parameters on the
 * query string, empty body, HTTP Basic with the public app client.
 */
export function buildAuthorizationCodeRequest(code: string, codeVerifier: string): PreparedRequest {
  const query = new URLSearchParams({
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
    client_id: OAUTH_CLIENT_ID,
    code,
    code_verifier: codeVerifier,
  });
  return {
    url: `${TOKEN_URL}?${query.toString()}`,
    method: 'POST',
    headers: {
      authorization: basicAuthorization(),
      accept: 'application/json',
      'content-length': '0',
    },
  };
}

/** Refresh-token grant. The refresh token itself does not rotate (ebox, 2026). */
export function buildRefreshRequest(refreshToken: string): PreparedRequest {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  return {
    url: TOKEN_URL,
    method: 'POST',
    headers: {
      authorization: basicAuthorization(),
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  };
}

export function parseTokenResponse(
  json: unknown,
  now = Date.now(),
  previousRefreshToken?: string,
): TokenSet {
  if (!json || typeof json !== 'object') {
    throw new DigitalPostError('Token endpoint returned a response that was not a JSON object.');
  }
  const record = json as Record<string, unknown>;
  const accessToken = record.access_token;
  const returnedRefresh = record.refresh_token;
  const refreshToken =
    typeof returnedRefresh === 'string' && returnedRefresh.length > 0
      ? returnedRefresh
      : previousRefreshToken;
  if (typeof accessToken !== 'string' || accessToken.length === 0 || !refreshToken) {
    throw new DigitalPostError(
      'Token endpoint response did not include an access token and a refresh token.',
    );
  }
  const expiresIn =
    typeof record.expires_in === 'number' && record.expires_in > 0 ? record.expires_in : 1200;
  return {
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
    tokenType: typeof record.token_type === 'string' ? record.token_type : 'Bearer',
  };
}

export function parseCallbackUrl(callbackUrl: string, expectedState?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new DigitalPostError('The login callback URL could not be parsed.');
  }
  const error = parsed.searchParams.get('error');
  if (error) {
    const description = parsed.searchParams.get('error_description');
    throw new DigitalPostError(
      `Login was refused (${error}${description ? `: ${description}` : ''}).`,
    );
  }
  const code = parsed.searchParams.get('code');
  if (!code)
    throw new DigitalPostError('The login callback did not contain an authorization code.');
  if (expectedState) {
    const state = parsed.searchParams.get('state');
    if (state !== expectedState) {
      throw new DigitalPostError('The login callback state did not match this attempt.');
    }
  }
  return code;
}

/** True when a redirect target is the app's custom-scheme callback. */
export function isAppCallback(url: string): boolean {
  return url.startsWith('eboksdk://') || url.startsWith('eboksdk:');
}
