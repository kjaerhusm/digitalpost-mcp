import { ACCESS_TOKEN_SKEW_MS, REFRESH_FAILURES_BEFORE_LOGIN_REQUIRED } from './constants.ts';
import { assertEboksMailRead } from './eboks-guard.ts';
import { LoginRequiredError, RefreshRejectedError } from './errors.ts';
import { assertMailRead } from './guard.ts';
import { guardedFetch } from './guarded-fetch.ts';
import {
  buildRefreshRequest,
  type PreparedRequest,
  parseTokenResponse,
  type TokenSet,
} from './oauth.ts';
import { REQUEST_TIMEOUT_MS } from './retry.ts';
import type { StoredLogin, TokenStore } from './token-store.ts';

export interface SessionOptions {
  store: TokenStore;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

/**
 * Holds the encrypted login and refreshes the access token (about 20 minutes)
 * when it is close to expiry. A rejected refresh token becomes a durable
 * `login_required` state so tools and `renew` fail clearly.
 */
export class Session {
  private readonly store: TokenStore;
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private refreshInFlight: Promise<TokenSet> | null = null;

  constructor(options: SessionOptions) {
    this.store = options.store;
    const inner = options.fetchImpl ?? guardedFetch;
    this.fetchImpl = async (url, init) => {
      const method = init?.method ?? 'GET';
      assertMailRead(method, url);
      assertEboksMailRead(method, url);
      return inner(url, init);
    };
    this.now = options.now ?? Date.now;
  }

  async status(): Promise<StoredLogin | null> {
    return this.store.load();
  }

  async requireLogin(): Promise<StoredLogin> {
    const stored = await this.store.load();
    if (stored?.status !== 'ok' || !stored?.tokens?.refreshToken) {
      throw new LoginRequiredError();
    }
    return stored;
  }

  async accessToken(options?: { force?: boolean }): Promise<string> {
    const stored = await this.requireLogin();
    const tokens = stored.tokens;
    if (!tokens) throw new LoginRequiredError();
    const fresh = !options?.force && tokens.expiresAt - this.now() > ACCESS_TOKEN_SKEW_MS;
    if (fresh) return tokens.accessToken;
    const next = await this.refresh(stored);
    return next.accessToken;
  }

  /** Used after an HTTP 401, even when the local expiry has not been reached. */
  async forceRefresh(): Promise<string> {
    return this.accessToken({ force: true });
  }

  /**
   * Cron entry point. Uses the refresh token and stores the new access token.
   * `force` retries a token that was kept after the login was marked
   * `login_required`. A normal renew does not.
   */
  async renew(options?: { force?: boolean }): Promise<{ expiresAt: number }> {
    const stored = await this.store.load();
    if (!stored?.tokens?.refreshToken) throw new LoginRequiredError();
    if (!options?.force && stored.status !== 'ok') throw new LoginRequiredError();
    const next = await this.refresh(stored);
    return { expiresAt: next.expiresAt };
  }

  private async refresh(stored: StoredLogin): Promise<TokenSet> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const tokens = stored.tokens;
    if (!tokens) throw new LoginRequiredError();
    this.refreshInFlight = this.refreshOnce(stored.username, tokens).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async refreshOnce(username: string | null, current: TokenSet): Promise<TokenSet> {
    const prepared = buildRefreshRequest(current.refreshToken);
    const response = await this.requestToken(prepared);
    if (response.status === 400 || response.status === 401) {
      const errorCode = await oauthErrorCode(response);
      if (errorCode === 'invalid_grant' || errorCode === 'invalid_token') {
        await this.store.markLoginRequired(username);
        throw new LoginRequiredError(
          'The stored login was rejected. Run `digitalpost login` and approve it in the MitID app.',
        );
      }
      const failures = await this.store.noteRefreshFailure(username);
      if (failures >= REFRESH_FAILURES_BEFORE_LOGIN_REQUIRED) {
        await this.store.markLoginRequired(username);
        throw new LoginRequiredError(
          'Token refresh failed repeatedly. Run `digitalpost login` and approve it in the MitID app.',
        );
      }
      throw new RefreshRejectedError(`Token refresh failed with HTTP ${response.status}.`);
    }
    if (!response.ok) {
      throw new RefreshRejectedError(`Token refresh failed with HTTP ${response.status}.`);
    }
    const json: unknown = await response.json();
    const next = parseTokenResponse(json, this.now(), current.refreshToken);
    await this.store.save({
      version: 1,
      status: 'ok',
      username,
      tokens: next,
      savedAt: this.now(),
      lastRenewAt: this.now(),
      refreshFailures: 0,
    });
    return next;
  }

  /**
   * One POST. Retrying can lose a rotated refresh token: the first response
   * may already have replaced it, and a second POST then comes back
   * invalid_grant. The renew loop tries again later. 429, 5xx, and timeouts
   * leave the stored login usable.
   */
  private async requestToken(prepared: PreparedRequest): Promise<Response> {
    try {
      return await this.fetchImpl(prepared.url, {
        method: prepared.method,
        headers: prepared.headers,
        ...(prepared.body ? { body: prepared.body } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new RefreshRejectedError('Could not reach the Digital Post token endpoint.', {
        cause: error,
      });
    }
  }
}

async function oauthErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}
