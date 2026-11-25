/**
 * One MitID login for the citizen Digital Post mailbox.
 *
 * Walks the e-Boks mobile OAuth redirect chain with the vendored MitID
 * client (username + app push / rotating QR). Stops when the chain redirects
 * to `eboksdk://ngdpoidc/callback` and exchanges that code for tokens.
 * The custom-scheme URL is never requested.
 */

import {
  extractFormAction,
  extractHiddenInputs,
  extractMetaRefreshUrl,
  extractText,
  generatePkce,
  HttpClient,
  type HttpResponse,
  MitidClient,
  mitidUrls,
  parseAuxResponse,
  randomBase64Url,
  sanitizeUrl,
} from '@digitalpost/mitid';
import * as cheerio from 'cheerio';
import { LoginFlowError } from './errors.ts';
import './guard.ts';
import { guardedFetch } from './guarded-fetch.ts';
import {
  buildAuthorizationCodeRequest,
  buildAuthorizeUrl,
  isAppCallback,
  parseCallbackUrl,
  parseTokenResponse,
  type TokenSet,
} from './oauth.ts';

export interface IdentityChoice {
  index: number;
  name: string;
  loginOptionsJson: string;
}

export interface LoginHooks {
  onStatus?: (message: string) => void | Promise<void>;
  onQr?: (qr: { qr1Json: string; qr2Json: string; updateCount: number }) => void | Promise<void>;
  onWaiting?: () => void | Promise<void>;
  selectIdentity?: (options: IdentityChoice[]) => Promise<number>;
  signal?: AbortSignal;
}

export interface LoginInput {
  username: string;
  deviceId: string;
  hooks?: LoginHooks;
  http?: HttpClient;
  fetchImpl?: typeof fetch;
}

export interface ChainHop {
  status: number;
  host: string;
}

export type ChainStop =
  | { type: 'mitid'; url: string; html: string; verificationToken: string; hops: ChainHop[] }
  | { type: 'callback'; url: string; code: string; hops: ChainHop[] }
  | { type: 'identity'; url: string; html: string; options: IdentityChoice[]; hops: ChainHop[] }
  | { type: 'page'; url: string; html: string; status: number; hops: ChainHop[] };

export interface AdvanceInput {
  url: string;
  method?: string;
  body?: URLSearchParams;
  headers?: Record<string, string>;
}

export async function login(input: LoginInput): Promise<{ tokens: TokenSet; username: string }> {
  const http = input.http ?? new HttpClient();
  const hooks = input.hooks ?? {};
  const pkce = generatePkce(64);
  const state = randomBase64Url(24);
  const nonce = randomBase64Url(32);
  const authorizeUrl = buildAuthorizeUrl({
    state,
    nonce,
    codeChallenge: pkce.challenge,
    deviceId: input.deviceId,
  });

  await hooks.onStatus?.('Opening Digital Post login.');
  const reached = await advanceAuthChain(
    http,
    { url: authorizeUrl, method: 'GET' },
    {
      stopAtMitid: true,
      ...(hooks.signal ? { signal: hooks.signal } : {}),
    },
  );
  if (reached.type !== 'mitid') {
    const title = reached.type === 'callback' ? null : pageTitle(reached.html);
    throw new LoginFlowError(
      `Login did not reach MitID (stopped at ${safeHost(reached.url)}${title ? `, “${title}”` : ''}).`,
    );
  }

  await hooks.onStatus?.('Starting MitID. Approve the push, or scan the QR code in the MitID app.');
  const aux = await initializeMitid(http, reached.verificationToken);
  const mitid = await MitidClient.create({ http, aux });
  const available = await mitid.identifyAsUser(input.username.trim());
  if (available.APP == null) {
    throw new LoginFlowError(
      `The MitID app authenticator is not available. Found: ${Object.keys(available).join(', ') || 'none'}.`,
    );
  }
  await mitid.authenticateWithApp(
    {
      ...(hooks.onWaiting ? { onWaiting: hooks.onWaiting } : {}),
      ...(hooks.onQr ? { onQr: hooks.onQr } : {}),
    },
    { ...(hooks.signal ? { signal: hooks.signal } : {}) },
  );
  const mitidCode = await mitid.finalize();

  await hooks.onStatus?.('MitID approved. Finishing Digital Post login.');
  const completion = await completeMitid(http, reached.url, reached.html, mitidCode, hooks);
  if (completion.type !== 'callback') {
    throw new LoginFlowError(
      `MitID finished but Digital Post did not return a login code (stopped at ${safeHost(completion.url)}).`,
    );
  }
  if (completion.code.length === 0)
    throw new LoginFlowError('The login callback had an empty code.');
  const code = parseCallbackUrl(completion.url, state);
  const tokens = await exchangeCode(code, pkce.verifier, input.fetchImpl ?? guardedFetch);
  await hooks.onStatus?.('Logged in. The refresh token is stored encrypted on this machine.');
  return { tokens, username: input.username.trim() };
}

/**
 * Follow redirects and auto-submitted forms.
 * Never requests a non-http(s) URL. An `eboksdk://` location is a successful stop.
 */
export async function advanceAuthChain(
  http: HttpClient,
  start: AdvanceInput,
  options: {
    stopAtMitid?: boolean;
    maxHops?: number;
    signal?: AbortSignal;
    onHop?: (hop: ChainHop) => void;
  } = {},
): Promise<ChainStop> {
  const maxHops = options.maxHops ?? 20;
  const hops: ChainHop[] = [];
  let url = start.url;
  let method = start.method ?? 'GET';
  let body = start.body;
  let headers = start.headers ?? {};

  for (let hop = 0; hop < maxHops; hop++) {
    options.signal?.throwIfAborted();
    const callback = callbackStop(url, hops);
    if (callback) return callback;
    assertLoginNavigationUrl(url);

    const response = await http.request(url, {
      method,
      headers,
      ...(body ? { body } : {}),
    });
    const recorded = { status: response.status, host: safeHost(response.url || url) };
    hops.push(recorded);
    options.onHop?.(recorded);
    trace(`${method} ${sanitizeUrl(url)} -> ${response.status}`);

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, url).toString();
      trace(`location ${sanitizeUrl(next)}`);
      const redirected = callbackStop(next, hops);
      if (redirected) return redirected;
      const preserve = response.status === 307 || response.status === 308;
      url = next;
      method = preserve ? method : 'GET';
      body = preserve ? body : undefined;
      headers = {};
      continue;
    }

    const html = response.body;
    const sourcePage = url;
    const meta = extractMetaRefreshUrl(html);
    if (meta) {
      url = new URL(meta, sourcePage).toString();
      method = 'GET';
      body = undefined;
      headers = {};
      trace(`redirect ${safeHost(sourcePage)} -> ${sanitizeUrl(url)}`);
      continue;
    }

    if (htmlIncludesSaml(html)) {
      const form = samlForm(html, sourcePage);
      trace(`form ${safeHost(sourcePage)} -> ${safeHost(form.action)}`);
      url = form.action;
      body = form.body;
      method = 'POST';
      headers = formHeaders(sourcePage);
      continue;
    }

    if (isIdentityPage(html)) {
      const optionsFound = parseIdentityOptions(html);
      return { type: 'identity', url, html, options: optionsFound, hops };
    }

    if (options.stopAtMitid && isMitidLoginPage(url, html)) {
      const verificationToken = extractHiddenInputs(html).__RequestVerificationToken;
      if (!verificationToken) {
        throw new LoginFlowError(
          `Reached a MitID page (${pageTitle(html) ?? safeHost(url)}) without a verification token.`,
        );
      }
      return { type: 'mitid', url, html, verificationToken, hops };
    }

    const auto = autoPostForm(html, sourcePage);
    if (auto) {
      trace(`form ${safeHost(sourcePage)} -> ${safeHost(auto.action)}`);
      url = auto.action;
      body = auto.body;
      method = 'POST';
      headers = formHeaders(sourcePage);
      continue;
    }

    // Script redirects are a fallback for pages that are not a form and not
    // the MitID login page. The real /login/mitid document has an inline
    // window.location error handler; following it lands on /error.
    const scriptTarget = pageHasForm(html) ? null : extractJsRedirect(html);
    if (scriptTarget) {
      url = new URL(scriptTarget, sourcePage).toString();
      method = 'GET';
      body = undefined;
      headers = {};
      trace(`script ${safeHost(sourcePage)} -> ${sanitizeUrl(url)}`);
      continue;
    }

    tracePageStop(url, response.status, html);
    return { type: 'page', url, html, status: response.status, hops };
  }

  throw new LoginFlowError(`Login exceeded ${maxHops} redirects at ${safeHost(url)}.`);
}

export async function probeAuthorizeChain(http?: HttpClient): Promise<{
  reachedMitid: boolean;
  finalUrl: string | null;
  hops: ChainHop[];
  title: string | null;
  stopped: string;
}> {
  const client = http ?? new HttpClient();
  const pkce = generatePkce();
  const url = buildAuthorizeUrl({
    state: randomBase64Url(16),
    nonce: randomBase64Url(16),
    codeChallenge: pkce.challenge,
    deviceId: 'probe-device',
  });
  try {
    const stop = await advanceAuthChain(
      client,
      { url, method: 'GET' },
      { stopAtMitid: true, maxHops: 15 },
    );
    const finalUrl = stop.url;
    return {
      reachedMitid: stop.type === 'mitid' && isMitidLoginUrl(stop.url),
      finalUrl,
      hops: stop.hops,
      title: stop.type === 'callback' ? null : pageTitle(stop.html),
      stopped: stop.type,
    };
  } catch (error) {
    return {
      reachedMitid: false,
      finalUrl: null,
      hops: [],
      title: null,
      stopped: error instanceof Error ? error.message : 'probe failed',
    };
  }
}

export function parseIdentityOptions(html: string): IdentityChoice[] {
  const $ = cheerio.load(html);
  const found: IdentityChoice[] = [];
  const seen = new Set<string>();
  $('a[data-loginoptions]').each((_, element) => {
    const json = $(element).attr('data-loginoptions');
    if (!json || seen.has(json)) return;
    seen.add(json);
    const label = $(element).find('.list-link-text').text().trim() || $(element).text().trim();
    found.push({
      index: found.length + 1,
      name: label || `Identity ${found.length + 1}`,
      loginOptionsJson: json,
    });
  });
  return found;
}

async function initializeMitid(http: HttpClient, verificationToken: string) {
  const response = await http.request(mitidUrls.loginMitidInitialize, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      origin: 'https://nemlog-in.mitid.dk',
      referer: 'https://nemlog-in.mitid.dk/login/mitid',
      'x-requested-with': 'XMLHttpRequest',
    },
    body: new URLSearchParams({ __RequestVerificationToken: verificationToken }),
  });
  if (response.status !== 200) {
    throw new LoginFlowError(`MitID initialize failed with HTTP ${response.status}.`);
  }
  return parseAuxResponse(response.body);
}

async function completeMitid(
  http: HttpClient,
  pageUrl: string,
  html: string,
  mitidCode: string,
  hooks: LoginHooks,
): Promise<ChainStop> {
  const sessionUuid = (await http.jar.getCookieValue(pageUrl, 'SessionUuid')) ?? '';
  const challenge = (await http.jar.getCookieValue(pageUrl, 'Challenge')) ?? '';
  const body = new URLSearchParams(extractHiddenInputs(html));
  body.set(
    '__RequestVerificationToken',
    extractHiddenInputs(html).__RequestVerificationToken ?? '',
  );
  body.set('MitIDAuthCode', mitidCode);
  body.set('MitIDUseConfirmed', 'True');
  if (sessionUuid) body.set('SessionStorageActiveSessionUuid', sessionUuid);
  if (challenge) body.set('SessionStorageActiveChallenge', challenge);

  let stop = await advanceAuthChain(
    http,
    {
      url: pageUrl,
      method: 'POST',
      body,
      headers: formHeaders(pageUrl),
    },
    { stopAtMitid: false, ...(hooks.signal ? { signal: hooks.signal } : {}) },
  );

  if (stop.type === 'identity') {
    const choice = await chooseIdentity(stop.options, hooks);
    const picked = stop.options.find((option) => option.index === choice);
    if (!picked) throw new LoginFlowError(`Identity ${choice} is not one of the offered choices.`);
    const again = new URLSearchParams(extractHiddenInputs(stop.html));
    again.set('ChosenOptionJson', picked.loginOptionsJson);
    const nextUuid = (await http.jar.getCookieValue(stop.url, 'SessionUuid')) ?? sessionUuid;
    const nextChallenge = (await http.jar.getCookieValue(stop.url, 'Challenge')) ?? challenge;
    if (nextUuid) again.set('SessionStorageActiveSessionUuid', nextUuid);
    if (nextChallenge) again.set('SessionStorageActiveChallenge', nextChallenge);
    stop = await advanceAuthChain(
      http,
      { url: stop.url, method: 'POST', body: again, headers: formHeaders(stop.url) },
      { stopAtMitid: false, ...(hooks.signal ? { signal: hooks.signal } : {}) },
    );
  }
  return stop;
}

async function chooseIdentity(options: IdentityChoice[], hooks: LoginHooks): Promise<number> {
  if (options.length === 1) return options[0]?.index ?? 1;
  const fromEnv = process.env.DIGITALPOST_IDENTITY;
  if (fromEnv && /^\d+$/.test(fromEnv)) return Number(fromEnv);
  if (!hooks.selectIdentity) {
    const names = options.map((option) => `${option.index}. ${option.name}`).join('; ');
    throw new LoginFlowError(
      `MitID offered several identities (${names}). Set DIGITALPOST_IDENTITY to the number, or pick one in the login page.`,
    );
  }
  return hooks.selectIdentity(options);
}

async function exchangeCode(
  code: string,
  verifier: string,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = guardedFetch,
): Promise<TokenSet> {
  const prepared = buildAuthorizationCodeRequest(code, verifier);
  const response = await fetchImpl(prepared.url, {
    method: prepared.method,
    headers: prepared.headers,
  });
  if (!response.ok) {
    throw new LoginFlowError(`Token exchange failed with HTTP ${response.status}.`);
  }
  const json: unknown = await response.json();
  return parseTokenResponse(json);
}

function callbackStop(url: string, hops: ChainHop[]): ChainStop | null {
  if (!isAppCallback(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const error = parsed.searchParams.get('error');
  if (error) {
    const description = parsed.searchParams.get('error_description');
    throw new LoginFlowError(
      `Login was refused (${error}${description ? `: ${description}` : ''}).`,
    );
  }
  const code = parsed.searchParams.get('code');
  if (!code) return null;
  return { type: 'callback', url, code, hops };
}

const LOGIN_HOST_SUFFIXES = [
  'digitalpost.dk',
  'nemlog-in.dk',
  'mitid.dk',
  'e-boks.dk',
  'e-boks.com',
];

/** https only, and only the hosts that participate in a Digital Post MitID login. */
export function isAllowedLoginUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return LOGIN_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function assertLoginNavigationUrl(url: string): void {
  if (isAllowedLoginUrl(url)) return;
  throw new LoginFlowError(
    `Refusing to follow ${safeHost(url)} during login. Only https hosts on the Digital Post and MitID allowlist are followed.`,
  );
}

/** A script-driven redirect some NemLog-in pages use instead of a Location header. */
export function extractJsRedirect(html: string): string | null {
  const patterns = [
    /window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i,
    /(?:window\.)?location\.replace\(\s*['"]([^'"]+)['"]\s*\)/i,
    /(?:window\.)?location\.assign\(\s*['"]([^'"]+)['"]\s*\)/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const target = match?.[1];
    if (target) return target;
  }
  return null;
}

function trace(line: string): void {
  if (process.env.DIGITALPOST_LOGIN_TRACE !== '1') return;
  process.stderr.write(`[digitalpost-login] ${line}\n`);
}

/** The MitID username page. `/error` is a different path and is not this page. */
export function isMitidLoginUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '') || '/';
    return path === '/login/mitid';
  } catch {
    return false;
  }
}

function isMitidLoginPage(url: string, html: string): boolean {
  if (!isMitidLoginUrl(url)) return false;
  if (htmlIncludesSaml(html)) return false;
  return Boolean(extractHiddenInputs(html).__RequestVerificationToken);
}

function pageHasForm(html: string): boolean {
  return /<form\b/i.test(html);
}

/** Identity choice is the anchor list. The URL stays /loginoption after the choice, when the body is the SAML form. */
function isIdentityPage(html: string): boolean {
  return /<a\b[^>]*\bdata-loginoptions=/i.test(html);
}

function tracePageStop(url: string, status: number, html: string): void {
  const title = pageTitle(html) ?? '';
  trace(`page host=${safeHost(url)} status=${status} title=${title} forms=${formFieldNames(html)}`);
}

/** Form actions and input names. Values are omitted; they can be SAML or tokens. */
function formFieldNames(html: string): string {
  const $ = cheerio.load(html);
  const forms: string[] = [];
  $('form').each((_, element) => {
    const action = $(element).attr('action') ?? '';
    let actionLabel = action;
    try {
      const parsed = new URL(action, 'https://nemlog-in.mitid.dk');
      actionLabel = `${parsed.host}${parsed.pathname}`;
    } catch {
      actionLabel = action.slice(0, 80);
    }
    const names: string[] = [];
    $(element)
      .find('input, select, textarea, button')
      .each((__, field) => {
        const name = $(field).attr('name');
        if (name) names.push(name);
      });
    forms.push(`${actionLabel} [${names.join(',')}]`);
  });
  return forms.join('; ') || 'none';
}

function htmlIncludesSaml(html: string): boolean {
  return /name=["']SAMLResponse["']/i.test(html);
}

function samlForm(html: string, baseUrl: string): { action: string; body: URLSearchParams } {
  const inputs = extractHiddenInputs(html);
  const saml = inputs.SAMLResponse;
  if (!saml) throw new LoginFlowError('Expected a SAML form and did not find one.');
  const actionAttr = extractFormAction(html) ?? baseUrl;
  const action = new URL(actionAttr, baseUrl).toString();
  const body = new URLSearchParams();
  body.set('SAMLResponse', saml);
  if (inputs.RelayState) body.set('RelayState', inputs.RelayState);
  return { action, body };
}

function autoPostForm(
  html: string,
  baseUrl: string,
): { action: string; body: URLSearchParams } | null {
  const actionAttr = extractFormAction(html);
  if (!actionAttr) return null;
  const inputs = extractHiddenInputs(html);
  const keys = Object.keys(inputs);
  if (keys.length === 0) return null;
  if (inputs.MitIDAuthCode !== undefined && !inputs.MitIDAuthCode) return null;
  const body = new URLSearchParams(inputs);
  return { action: new URL(actionAttr, baseUrl).toString(), body };
}

function formHeaders(url: string): Record<string, string> {
  let origin = 'https://nemlog-in.mitid.dk';
  try {
    origin = new URL(url).origin;
  } catch {
    // keep the default
  }
  return {
    origin,
    referer: url,
    'content-type': 'application/x-www-form-urlencoded',
  };
}

function pageTitle(html: string): string | null {
  return extractText(html, 'title');
}

function safeHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.protocol;
  } catch {
    return 'unknown-url';
  }
}

export function responseHasVerificationToken(response: HttpResponse): boolean {
  return response.body.includes('__RequestVerificationToken');
}
