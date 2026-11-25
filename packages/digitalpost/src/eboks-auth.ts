import {
  EBOKS_API_BASE,
  EBOKS_CLIENT_ID,
  EBOKS_CLIENT_SECRET,
  EBOKS_TOKEN_SKEW_MS,
  EBOKS_TOKEN_URL,
  EBOKS_USER_TOKEN_URL,
  ENV,
} from './constants.ts';
import { publicKeySpkiBase64, type StoredEboksDevice } from './eboks-device.ts';
import { DigitalPostError } from './errors.ts';
import { guardedFetch } from './guarded-fetch.ts';
import type { PreparedRequest } from './oauth.ts';

export interface EboksAccess {
  accessToken: string;
  expiresAt: number;
}

export function buildUserTokenRequest(digitalPostAccessToken: string): PreparedRequest {
  return {
    url: EBOKS_USER_TOKEN_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${digitalPostAccessToken}`,
      accept: 'application/json',
      'content-type': 'application/json-patch+json',
      'content-length': '0',
      'x-operation-id': 'LoginService_UserToken',
    },
  };
}

export function buildEboksTokenRequest(userToken: string, deviceId: string): PreparedRequest {
  const body = new URLSearchParams({
    usertoken: userToken,
    grant_type: 'usertoken',
    scope: 'mobileapi offline_access',
    client_id: EBOKS_CLIENT_ID,
    client_secret: EBOKS_CLIENT_SECRET,
    deviceid: deviceId,
  });
  return {
    url: EBOKS_TOKEN_URL,
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  };
}

export function buildVerifyPasswordRequest(password: string): PreparedRequest {
  const body = new URLSearchParams({ password });
  return {
    url: `${EBOKS_API_BASE}/user/mobileaccess/password/verify`,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  };
}

export function buildRegisterDeviceRequest(device: StoredEboksDevice): {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  body: string;
} {
  return {
    url: `${EBOKS_API_BASE}/user/current/device`,
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      id: device.id,
      key: publicKeySpkiBase64(device.privateKeyPem),
      name: 'digitalpost-mcp',
      os: 'linux',
    }),
  };
}

export function parseEboksToken(json: unknown, now = Date.now()): EboksAccess {
  if (!json || typeof json !== 'object') {
    throw new DigitalPostError('e-Boks token response was not JSON.');
  }
  const record = json as Record<string, unknown>;
  const accessToken = record.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new DigitalPostError('e-Boks token response did not include an access token.');
  }
  const expiresIn =
    typeof record.expires_in === 'number' && record.expires_in > 0 ? record.expires_in : 300;
  return { accessToken, expiresAt: now + expiresIn * 1000 };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Trade a Digital Post access token for a short-lived e-Boks mobile token. */
export async function exchangeEboksToken(
  digitalPostAccessToken: string,
  deviceId: string,
  fetchImpl: FetchLike = guardedFetch,
  now = Date.now(),
): Promise<EboksAccess> {
  const userRequest = buildUserTokenRequest(digitalPostAccessToken);
  const userResponse = await fetchImpl(userRequest.url, {
    method: userRequest.method,
    headers: userRequest.headers,
    body: '',
  });
  if (!userResponse.ok) {
    throw new DigitalPostError(`e-Boks user token failed with HTTP ${userResponse.status}.`);
  }
  const userJson = (await userResponse.json()) as { userToken?: unknown };
  if (typeof userJson.userToken !== 'string' || userJson.userToken.length === 0) {
    throw new DigitalPostError('e-Boks user token response did not include userToken.');
  }
  const tokenRequest = buildEboksTokenRequest(userJson.userToken, deviceId);
  const tokenResponse = await fetchImpl(tokenRequest.url, {
    method: tokenRequest.method,
    headers: tokenRequest.headers,
    ...(tokenRequest.body ? { body: tokenRequest.body } : {}),
  });
  if (!tokenResponse.ok) {
    throw new DigitalPostError(`e-Boks token exchange failed with HTTP ${tokenResponse.status}.`);
  }
  return parseEboksToken(await tokenResponse.json(), now);
}

export function tokenStillFresh(access: EboksAccess, now = Date.now()): boolean {
  return access.expiresAt - now > EBOKS_TOKEN_SKEW_MS;
}

/** e-Boks tools stay off unless this is set. Registration via the CLI does not need it. */
export function eboksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[ENV.eboks];
  return value === '1' || value === 'true';
}
