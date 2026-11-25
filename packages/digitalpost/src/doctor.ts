import { access, constants, stat } from 'node:fs/promises';
import { type DigitalPostPaths, loopbackHost } from './config.ts';
import { AUTHORIZE_URL } from './constants.ts';
import { assertMailRead } from './guard.ts';
import { probeAuthorizeChain } from './login.ts';
import type { TokenStore } from './token-store.ts';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(options: {
  paths: DigitalPostPaths;
  store: TokenStore;
  probe?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];

  checks.push(bindCheck('mcp bind', process.env.DIGITALPOST_MCP_HOST));
  checks.push(bindCheck('login bind', process.env.DIGITALPOST_LOGIN_HOST));

  try {
    assertMailRead('GET', 'https://gateway.digitalpost.dk/apis/v1/mailboxes/');
    let rejected = false;
    try {
      assertMailRead('PATCH', 'https://gateway.digitalpost.dk/apis/v1/mailboxes/x/messages/y');
    } catch {
      rejected = true;
    }
    checks.push({
      name: 'read-only guard',
      ok: rejected,
      detail: rejected
        ? 'Non-GET mail requests are rejected before the network.'
        : 'Guard did not reject PATCH.',
    });
  } catch (error) {
    checks.push({
      name: 'read-only guard',
      ok: false,
      detail: error instanceof Error ? error.message : 'failed',
    });
  }

  try {
    await access(options.paths.dir, constants.R_OK | constants.W_OK);
    const info = await stat(options.paths.dir);
    const mode = info.mode & 0o777;
    checks.push({
      name: 'config dir',
      ok: mode === 0o700 || process.platform === 'win32',
      detail: `${options.paths.dir} mode ${mode.toString(8)}`,
    });
  } catch {
    checks.push({
      name: 'config dir',
      ok: true,
      detail: `${options.paths.dir} will be created on login (mode 0700).`,
    });
  }

  try {
    const stored = await options.store.load();
    if (!stored) {
      checks.push({ name: 'login', ok: true, detail: 'No login stored. Run digitalpost login.' });
    } else if (stored.status === 'login_required') {
      checks.push({
        name: 'login',
        ok: false,
        detail: 'Stored login is marked login_required. Run digitalpost login.',
      });
    } else {
      const expires = stored.tokens?.expiresAt
        ? new Date(stored.tokens.expiresAt).toISOString()
        : 'unknown';
      checks.push({
        name: 'login',
        ok: true,
        detail: `Login present for ${stored.username ?? 'unknown user'}. Access token expiry ${expires}.`,
      });
    }
  } catch (error) {
    checks.push({
      name: 'login',
      ok: false,
      detail: error instanceof Error ? error.message : 'Could not read the token file.',
    });
  }

  checks.push(await reachability(options.fetchImpl ?? fetch));

  if (options.probe) {
    const probe = await probeAuthorizeChain();
    const hopText = probe.hops.map((hop) => `${hop.status} ${hop.host}`).join(' → ') || 'no hops';
    const landed = loginPath(probe.finalUrl);
    checks.push({
      name: 'mitid probe',
      ok: probe.reachedMitid,
      detail: probe.reachedMitid
        ? `Stopped on ${landed} via ${hopText}.`
        : `Did not stop on /login/mitid (landed on ${landed}, ${probe.stopped}). Hops: ${hopText}.`,
    });
  }

  return { ok: checks.every((check) => check.ok), checks };
}

function loginPath(url: string | null): string {
  if (!url) return 'unknown';
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return 'unknown';
  }
}

function bindCheck(name: string, raw: string | undefined): DoctorCheck {
  try {
    const host = loopbackHost(raw);
    return { name, ok: true, detail: `Binds to ${host}.` };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : 'refused' };
  }
}

async function reachability(fetchImpl: typeof fetch): Promise<DoctorCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(AUTHORIZE_URL, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    return {
      name: 'gateway',
      ok: response.status > 0 && response.status < 500,
      detail: `GET authorize responded HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      name: 'gateway',
      ok: false,
      detail:
        error instanceof Error ? `Could not reach Digital Post (${error.message}).` : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}
