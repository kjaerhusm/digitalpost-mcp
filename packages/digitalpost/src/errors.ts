export class DigitalPostError extends Error {
  override readonly name: string = 'DigitalPostError';
  override readonly cause: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.cause = options?.cause;
  }
}

/** No usable login. Callers should tell the user to run `digitalpost login`. */
export class LoginRequiredError extends DigitalPostError {
  override readonly name: string = 'LoginRequiredError';
  readonly code = 'login_required' as const;
  readonly hint = 'Run `digitalpost login` and approve it in the MitID app.';

  constructor(
    message = 'Login required. Run `digitalpost login` and approve it in the MitID app.',
  ) {
    super(message);
  }
}

/** The gateway returned HTTP 429 after retries. Nothing was changed. */
export class RateLimitedError extends DigitalPostError {
  override readonly name: string = 'RateLimitedError';
  readonly code = 'rate_limited' as const;
  readonly hint =
    'The service asked us to slow down. Wait and try again. Nothing was marked read and nothing was deleted.';

  constructor(
    readonly service: string,
    readonly path: string,
  ) {
    super(`${service} is rate limiting requests for ${path}.`);
  }
}

/**
 * The JSON was not the shape this program knows. The raw body is not included:
 * it can contain a letter or a CPR.
 */
export class UpstreamChangedError extends DigitalPostError {
  override readonly name: string = 'UpstreamChangedError';
  readonly code = 'upstream_changed' as const;
  readonly hint =
    'The response did not match the expected shape, so no letters were guessed. The API may have changed.';

  constructor(path: string) {
    super(`The response from ${path} did not match the expected shape.`);
  }
}

/** Content was fetched from e-Boks, which marks the letter read, and a later step failed. */
export class ContentFetchedError extends DigitalPostError {
  override readonly name: string = 'ContentFetchedError';
  readonly code = 'error' as const;
  readonly markedRead = true as const;
  readonly hint =
    'e-Boks marks this letter read when its content is downloaded. This program cannot undo that.';

  constructor(message: string) {
    super(message);
  }
}

/** The refresh token was rejected. The stored login is no longer usable. */
export class RefreshRejectedError extends DigitalPostError {
  override readonly name: string = 'RefreshRejectedError';
}

export class ReadOnlyError extends DigitalPostError {
  override readonly name: string = 'ReadOnlyError';
}

export class ApiError extends DigitalPostError {
  override readonly name: string = 'ApiError';
  readonly code = 'error' as const;
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly hint = 'The request failed. Nothing was changed.',
  ) {
    super(message);
  }
}

export class LoginFlowError extends DigitalPostError {
  override readonly name: string = 'LoginFlowError';
}
