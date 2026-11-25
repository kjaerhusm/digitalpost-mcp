import { ApiError, RateLimitedError } from './errors.ts';

/** First try plus three retries. */
export const RETRY_ATTEMPTS = 4;
export const REQUEST_TIMEOUT_MS = 15_000;

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** Retry-After is seconds. Otherwise exponential backoff, capped at 8 seconds. */
export function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader != null && retryAfterHeader.trim() !== '') {
    const retryAfter = Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 8_000);
  }
  return Math.min(200 * 2 ** attempt, 8_000);
}

/**
 * Retries a GET on 429, 5xx, and network timeouts. The last 429 becomes
 * `rate_limited`. Other final responses are returned to the caller.
 */
export async function sendWithRetry(options: {
  send: () => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  path: string;
  attempts?: number;
  service?: string;
}): Promise<Response> {
  const attempts = options.attempts ?? RETRY_ATTEMPTS;
  const service = options.service ?? 'Digital Post';
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;
    try {
      response = await options.send();
    } catch {
      if (attempt === attempts - 1) {
        throw new ApiError(
          `${service} did not respond in time for ${options.path}.`,
          0,
          options.path,
          'The request timed out or the network failed. Nothing was changed. Try again shortly.',
        );
      }
      await options.sleep(retryDelayMs(attempt, null));
      continue;
    }
    const lastTry = attempt === attempts - 1;
    if (!isRetryableStatus(response.status) || lastTry) {
      if (response.status === 429) {
        await response.body?.cancel().catch(() => undefined);
        throw new RateLimitedError(service, options.path);
      }
      return response;
    }
    const retryAfter = response.headers.get('retry-after');
    await response.body?.cancel().catch(() => undefined);
    await options.sleep(retryDelayMs(attempt, retryAfter));
  }
  throw new ApiError(
    `${service} did not respond in time for ${options.path}.`,
    0,
    options.path,
    'The request timed out or the network failed. Nothing was changed. Try again shortly.',
  );
}
