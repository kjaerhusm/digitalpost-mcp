import {
  ApiError,
  ContentFetchedError,
  LoginRequiredError,
  RateLimitedError,
  UpstreamChangedError,
} from '@digitalpost/client';

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function jsonResult(value: unknown, isError = false): ToolResult {
  const result: ToolResult = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
  if (isError) result.isError = true;
  return result;
}

export function toolFailure(error: unknown): ToolResult {
  const markedRead = error instanceof ContentFetchedError;
  const base = markedRead ? { markedRead: true } : {};
  if (
    error instanceof LoginRequiredError ||
    error instanceof RateLimitedError ||
    error instanceof UpstreamChangedError
  ) {
    return jsonResult(
      { ...base, status: error.code, message: error.message, hint: error.hint },
      true,
    );
  }
  if (error instanceof ApiError || error instanceof ContentFetchedError) {
    return jsonResult({ ...base, status: 'error', message: error.message, hint: error.hint }, true);
  }
  const message = error instanceof Error ? error.message : 'Digital Post request failed.';
  return jsonResult({ ...base, status: 'error', message }, true);
}
