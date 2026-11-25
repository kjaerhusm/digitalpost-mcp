import { describe, expect, test } from 'bun:test';
import { MAIL_API_BASE, REDIRECT_URI, TOKEN_URL } from './constants.ts';
import {
  buildAuthorizationCodeRequest,
  buildAuthorizeUrl,
  buildRefreshRequest,
  isAppCallback,
  parseCallbackUrl,
  parseTokenResponse,
} from './oauth.ts';

describe('PKCE authorize URL', () => {
  test('builds the e-Boks mobile authorize request without the client secret', () => {
    const url = new URL(
      buildAuthorizeUrl({
        state: 'state-1',
        nonce: 'nonce-1',
        codeChallenge: 'challenge-1',
        deviceId: 'device-1',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://gateway.digitalpost.dk/auth/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('e-boks-mobile');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('idp')).toBe('nemloginEboksRealm');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.search).not.toContain('client_secret');
    expect(url.search).not.toContain('y0vKRKo');
  });
});

describe('token requests', () => {
  test('refresh posts to the token host and not the mail API', () => {
    const request = buildRefreshRequest('refresh-secret');
    expect(request.method).toBe('POST');
    expect(request.url).toBe(TOKEN_URL);
    expect(request.url.startsWith(MAIL_API_BASE)).toBe(false);
    expect(request.body).toContain('grant_type=refresh_token');
    expect(request.body).toContain('refresh_token=refresh-secret');
    expect(request.headers.authorization?.startsWith('Basic ')).toBe(true);
  });

  test('authorization-code exchange keeps the code off the mail API', () => {
    const request = buildAuthorizationCodeRequest('auth-code', 'verifier');
    expect(request.method).toBe('POST');
    expect(request.url.startsWith(TOKEN_URL)).toBe(true);
    expect(request.url).toContain('grant_type=authorization_code');
    expect(request.url).toContain('code=auth-code');
    expect(request.url).toContain('code_verifier=verifier');
    expect(request.body).toBeUndefined();
    expect(request.url.includes('/apis/v1')).toBe(false);
  });

  test('keeps the previous refresh token when the server does not rotate it', () => {
    const tokens = parseTokenResponse(
      { access_token: 'access-new', expires_in: 1200, token_type: 'Bearer' },
      1_000,
      'refresh-old',
    );
    expect(tokens.accessToken).toBe('access-new');
    expect(tokens.refreshToken).toBe('refresh-old');
    expect(tokens.expiresAt).toBe(1_000 + 1200 * 1000);
    expect(JSON.stringify(tokens)).not.toContain('id_token');
  });

  test('parses the app callback and checks state', () => {
    const url = 'eboksdk://ngdpoidc/callback?code=abc&state=s1';
    expect(isAppCallback(url)).toBe(true);
    expect(parseCallbackUrl(url, 's1')).toBe('abc');
    expect(() => parseCallbackUrl(url, 'other')).toThrow(/state/);
  });
});
