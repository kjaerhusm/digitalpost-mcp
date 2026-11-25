import { describe, expect, test } from 'bun:test';
import { challengeFromVerifier, generatePkce, HttpClient } from '@digitalpost/mitid';
import {
  advanceAuthChain,
  extractJsRedirect,
  isAllowedLoginUrl,
  isMitidLoginUrl,
  parseIdentityOptions,
  probeAuthorizeChain,
} from './login.ts';

describe('PKCE', () => {
  test('S256 challenge matches SHA-256 of the verifier', () => {
    const pair = generatePkce();
    expect(pair.method).toBe('S256');
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.verifier.length).toBeLessThanOrEqual(128);
    expect(pair.challenge).toBe(challengeFromVerifier(pair.verifier));
    expect(pair.challenge).not.toContain('=');
  });
});

describe('authorize chain', () => {
  test('stops at the MitID page and does not request the app callback', async () => {
    const requested: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/oauth/authorize')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://nemlog-in.mitid.dk/login/mitid' },
        });
      }
      if (url.startsWith('https://nemlog-in.mitid.dk/login/mitid')) {
        return new Response(
          '<html><head><title>MitID</title></head><body><form><input type="hidden" name="__RequestVerificationToken" value="tok"></form></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    try {
      const stop = await advanceAuthChain(
        new HttpClient(),
        { url: 'https://gateway.digitalpost.dk/auth/oauth/authorize?client_id=e-boks-mobile' },
        { stopAtMitid: true },
      );
      expect(stop.type).toBe('mitid');
      if (stop.type === 'mitid') expect(stop.verificationToken).toBe('tok');
      expect(requested.every((url) => url.startsWith('https://'))).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('captures an eboksdk callback without requesting it', async () => {
    const requested: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      return new Response(null, {
        status: 302,
        headers: { location: 'eboksdk://ngdpoidc/callback?code=the-code&state=abc' },
      });
    }) as unknown as typeof fetch;
    try {
      const stop = await advanceAuthChain(
        new HttpClient(),
        { url: 'https://gateway.digitalpost.dk/auth/sso/resume' },
        { stopAtMitid: false },
      );
      expect(stop.type).toBe('callback');
      if (stop.type === 'callback') expect(stop.code).toBe('the-code');
      expect(requested).toEqual(['https://gateway.digitalpost.dk/auth/sso/resume']);
      expect(requested.some((url) => url.startsWith('eboksdk:'))).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('parses identity choices without keeping raw option payloads in the label', () => {
    const html = `
      <a class="list-link" data-loginoptions="{&quot;id&quot;:&quot;1&quot;}">
        <div class="list-link-text">Privat</div>
      </a>
    `;
    const options = parseIdentityOptions(html);
    expect(options).toHaveLength(1);
    expect(options[0]?.name).toBe('Privat');
    expect(options[0]?.index).toBe(1);
  });

  test('posts a SAML form with Origin and Referer from the source page', async () => {
    const seen: Array<{ url: string; origin: string | null; referer: string | null }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({
        url,
        origin: headers.get('origin'),
        referer: headers.get('referer'),
      });
      if (url.includes('/login/mitid')) {
        return new Response(
          '<form action="https://gateway.digitalpost.dk/auth/saml" method="post"><input type="hidden" name="SAMLResponse" value="abc"></form>',
          { status: 200 },
        );
      }
      return new Response('<html><title>Done</title></html>', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const stop = await advanceAuthChain(
        new HttpClient(),
        { url: 'https://nemlog-in.mitid.dk/login/mitid', method: 'GET' },
        { stopAtMitid: false },
      );
      expect(stop.type).toBe('page');
      expect(seen[1]?.url).toBe('https://gateway.digitalpost.dk/auth/saml');
      expect(seen[1]?.origin).toBe('https://nemlog-in.mitid.dk');
      expect(seen[1]?.referer).toBe('https://nemlog-in.mitid.dk/login/mitid');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('surfaces an OAuth error callback instead of treating it as a bad URL', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: {
          location: 'eboksdk://ngdpoidc/callback?error=access_denied&error_description=no',
        },
      })) as unknown as typeof fetch;
    try {
      await expect(
        advanceAuthChain(
          new HttpClient(),
          { url: 'https://gateway.digitalpost.dk/auth/sso/resume' },
          { stopAtMitid: false },
        ),
      ).rejects.toThrow(/access_denied/);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('refuses http and hosts outside the allowlist', async () => {
    expect(isAllowedLoginUrl('https://gateway.digitalpost.dk/auth/oauth/authorize')).toBe(true);
    expect(isAllowedLoginUrl('https://nemlog-in.mitid.dk/login/mitid')).toBe(true);
    expect(isAllowedLoginUrl('http://nemlog-in.mitid.dk/login/mitid')).toBe(false);
    expect(isAllowedLoginUrl('https://evil.example/login')).toBe(false);
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/steal' },
      })) as unknown as typeof fetch;
    try {
      await expect(
        advanceAuthChain(new HttpClient(), {
          url: 'https://gateway.digitalpost.dk/auth/sso/resume',
        }),
      ).rejects.toThrow(/evil\.example/);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('follows a JavaScript redirect after the page', async () => {
    expect(
      extractJsRedirect('window.location.href = "https://gateway.digitalpost.dk/next";'),
    ).toContain('gateway.digitalpost.dk');
    const requested: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/resume')) {
        return new Response(
          '<script>window.location = "https://nemlog-in.mitid.dk/login/mitid";</script>',
          {
            status: 200,
          },
        );
      }
      return new Response(
        '<html><title>MitID</title><form><input type="hidden" name="__RequestVerificationToken" value="tok"></form></html>',
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      const stop = await advanceAuthChain(
        new HttpClient(),
        { url: 'https://gateway.digitalpost.dk/auth/sso/resume' },
        { stopAtMitid: true },
      );
      expect(stop.type).toBe('mitid');
      expect(
        requested.some((url) => url.startsWith('https://nemlog-in.mitid.dk/login/mitid')),
      ).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a SAML form posted back to /loginoption is followed', async () => {
    const requested: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requested.push(`${method} ${url}`);
      if (url.endsWith('/loginoption')) {
        return new Response(
          '<html><form action="https://gateway.digitalpost.dk/auth/s9/e-boks-nemlogin/ssoack" method="post"><input type="hidden" name="SAMLResponse" value="SECRET-SAML"><input type="hidden" name="RelayState" value="rs"></form></html>',
          { status: 200 },
        );
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'eboksdk://ngdpoidc/callback?code=the-code&state=abc' },
      });
    }) as unknown as typeof fetch;
    try {
      const stop = await advanceAuthChain(
        new HttpClient(),
        {
          url: 'https://nemlog-in.mitid.dk/loginoption',
          method: 'POST',
          body: new URLSearchParams({ ChosenOptionJson: '{}' }),
        },
        { stopAtMitid: false },
      );
      expect(stop.type).toBe('callback');
      expect(
        requested.some((line) => line.startsWith('POST https://gateway.digitalpost.dk/auth/s9/')),
      ).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('an inline window.location on the MitID page is not followed', async () => {
    const requested: string[] = [];
    const original = globalThis.fetch;
    const html = `<html><title>MitID</title>
      <form><input type="hidden" name="__RequestVerificationToken" value="tok"></form>
      <script>window.location = "https://nemlog-in.mitid.dk/error";</script>
      </html>`;
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(html, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const stop = await advanceAuthChain(
        new HttpClient(),
        { url: 'https://nemlog-in.mitid.dk/login/mitid' },
        { stopAtMitid: true },
      );
      expect(stop.type).toBe('mitid');
      expect(isMitidLoginUrl(stop.url)).toBe(true);
      expect(requested).toEqual(['https://nemlog-in.mitid.dk/login/mitid']);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('probe fails when the chain lands on /error', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/oauth/authorize')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://nemlog-in.mitid.dk/error' },
        });
      }
      return new Response(
        '<html><title>MitID</title><form><input type="hidden" name="__RequestVerificationToken" value="tok"></form><p>mitid</p></html>',
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      const probe = await probeAuthorizeChain(new HttpClient());
      expect(probe.reachedMitid).toBe(false);
      expect(probe.finalUrl).toContain('/error');
      expect(isMitidLoginUrl(probe.finalUrl ?? '')).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a final page traces title and field names without values', async () => {
    const previous = process.env.DIGITALPOST_LOGIN_TRACE;
    process.env.DIGITALPOST_LOGIN_TRACE = '1';
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        '<html><title>Stuck</title><form action="/stay"><button name="go" value="SECRET-VALUE">Go</button></form></html>',
        { status: 200 },
      )) as unknown as typeof fetch;
    try {
      const stop = await advanceAuthChain(
        new HttpClient(),
        { url: 'https://nemlog-in.mitid.dk/login/mitid' },
        { stopAtMitid: false },
      );
      expect(stop.type).toBe('page');
      const trace = lines.join('\n');
      expect(trace).toContain('page host=nemlog-in.mitid.dk status=200 title=Stuck');
      expect(trace).toContain('go');
      expect(trace).not.toContain('SECRET-VALUE');
    } finally {
      process.stderr.write = write;
      globalThis.fetch = original;
      if (previous === undefined) delete process.env.DIGITALPOST_LOGIN_TRACE;
      else process.env.DIGITALPOST_LOGIN_TRACE = previous;
    }
  });

  test('login trace redacts the authorization code', async () => {
    const previous = process.env.DIGITALPOST_LOGIN_TRACE;
    process.env.DIGITALPOST_LOGIN_TRACE = '1';
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'eboksdk://ngdpoidc/callback?code=SUPER-SECRET-CODE&state=abc' },
      })) as unknown as typeof fetch;
    try {
      await advanceAuthChain(new HttpClient(), {
        url: 'https://gateway.digitalpost.dk/auth/sso/resume',
      });
      const trace = lines.join('\n');
      expect(trace).toContain('[digitalpost-login]');
      expect(trace).not.toContain('SUPER-SECRET-CODE');
    } finally {
      process.stderr.write = write;
      globalThis.fetch = original;
      if (previous === undefined) delete process.env.DIGITALPOST_LOGIN_TRACE;
      else process.env.DIGITALPOST_LOGIN_TRACE = previous;
    }
  });
});
