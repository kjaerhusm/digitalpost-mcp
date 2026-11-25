import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EBOKS_API_BASE, EBOKS_TOKEN_URL, EBOKS_USER_TOKEN_URL } from './constants.ts';
import { registerEboksDevice } from './eboks-api.ts';
import {
  buildEboksTokenRequest,
  buildRegisterDeviceRequest,
  buildUserTokenRequest,
  exchangeEboksToken,
} from './eboks-auth.ts';
import { EboksDeviceStore, generateEboksDevice, publicKeySpkiBase64 } from './eboks-device.ts';

describe('e-Boks auth requests', () => {
  test('user-token request is an empty POST with the Digital Post bearer', () => {
    const request = buildUserTokenRequest('dp-access');
    expect(request.url).toBe(EBOKS_USER_TOKEN_URL);
    expect(request.method).toBe('POST');
    expect(request.headers.authorization).toBe('Bearer dp-access');
    expect(request.headers['content-length']).toBe('0');
    expect(request.body).toBeUndefined();
    expect(request.url.includes('/apis/v1')).toBe(false);
  });

  test('token request carries the device id and not a mail path', () => {
    const request = buildEboksTokenRequest('user-tok', 'device-1');
    expect(request.url).toBe(EBOKS_TOKEN_URL);
    expect(request.body).toContain('grant_type=usertoken');
    expect(request.body).toContain('deviceid=device-1');
    expect(request.body).toContain('usertoken=user-tok');
    expect(request.url.includes('/2/mail')).toBe(false);
  });

  test('device registration uploads the public key only', () => {
    const device = generateEboksDevice();
    const request = buildRegisterDeviceRequest(device);
    expect(request.method).toBe('PUT');
    expect(request.url).toBe(`${EBOKS_API_BASE}/user/current/device`);
    const body = JSON.parse(request.body) as { id: string; key: string };
    expect(body.id).toBe(device.id);
    expect(body.key).toBe(publicKeySpkiBase64(device.privateKeyPem));
    expect(request.body).not.toContain('PRIVATE KEY');
    expect(request.body).not.toContain(device.privateKeyPem);
  });

  test('exchange keeps the user token off the mail API', async () => {
    const calls: string[] = [];
    const access = await exchangeEboksToken('dp-access', 'device-1', async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (String(url).includes('usertoken')) return Response.json({ userToken: 'user-tok' });
      return Response.json({ access_token: 'eboks-access', expires_in: 300 });
    });
    expect(access.accessToken).toBe('eboks-access');
    expect(calls[0]).toContain(EBOKS_USER_TOKEN_URL);
    expect(calls[1]).toContain(EBOKS_TOKEN_URL);
    expect(calls.every((call) => !call.includes('/2/mail'))).toBe(true);
  });
});

describe('e-Boks registration', () => {
  test('stores the device encrypted and does not store the password', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'digitalpost-eboks-'));
    await chmod(dir, 0o700);
    const paths = {
      dir,
      tokenFile: join(dir, 'tokens.enc'),
      keyFile: join(dir, '.key'),
      deviceIdFile: join(dir, 'device-id'),
      downloadDir: join(dir, 'downloads'),
    };
    const device = generateEboksDevice();
    const password = 'mobile-secret-not-stored';
    await registerEboksDevice({
      digitalPostAccessToken: 'dp-access',
      password,
      device,
      paths,
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.includes('usertoken')) return Response.json({ userToken: 'user-tok' });
        if (target.includes('oauth-dk.e-boks.com')) {
          return Response.json({ access_token: 'eboks-access', expires_in: 300 });
        }
        if (target.endsWith('/user/profile')) {
          return Response.json({ name: 'Test Person', identity: '0000000000' });
        }
        return new Response(null, { status: 204 });
      },
    });
    const stored = await new EboksDeviceStore(paths).load();
    expect(stored?.activated).toBe(true);
    expect(stored?.name).toBe('Test Person');
    expect(stored?.privateKeyPem).toContain('PRIVATE KEY');
    const raw = await readFile(join(dir, 'eboks-device.enc'), 'utf8');
    expect(raw).not.toContain(password);
    expect(raw).not.toContain('0000000000');
    expect(raw).not.toContain('PRIVATE KEY');
  });
});
