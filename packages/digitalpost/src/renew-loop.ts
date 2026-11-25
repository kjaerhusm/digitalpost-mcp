import { ENV } from './constants.ts';
import { LoginRequiredError } from './errors.ts';
import type { Session } from './session.ts';

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;

export type RenewOutcome = 'ok' | 'login_required' | 'transient';

export interface RenewLogger {
  info: (event: string) => void;
  warn: (event: string) => void;
}

export function renewIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV.renewInterval];
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MS;
  return Math.min(Math.max(parsed, MIN_INTERVAL_MS), MAX_INTERVAL_MS);
}

/**
 * Refreshes the access token on an interval in the same process as the server.
 * A rejected refresh becomes login_required inside Session and the refresh
 * token stays on disk. A timeout or 5xx stays transient and does not delete it.
 */
export function startRenewLoop(
  session: Session,
  options?: { intervalMs?: number; logger?: RenewLogger; immediate?: boolean },
): { stop: () => void; runOnce: () => Promise<RenewOutcome> } {
  const interval = options?.intervalMs ?? renewIntervalMs();
  const runOnce = async (): Promise<RenewOutcome> => {
    try {
      await session.renew();
      options?.logger?.info('digitalpost.renewed');
      return 'ok';
    } catch (error) {
      if (error instanceof LoginRequiredError) {
        options?.logger?.warn('digitalpost.login_required');
        return 'login_required';
      }
      options?.logger?.warn('digitalpost.renew_failed');
      return 'transient';
    }
  };
  if (options?.immediate !== false) void runOnce();
  const timer = setInterval(() => void runOnce(), interval);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
    runOnce,
  };
}
