import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { EboksApi } from './eboks-api.ts';
import { generateEboksDevice } from './eboks-device.ts';

const device = generateEboksDevice();

describe('EboksApi', () => {
  test('lists mail with GET only and strips a CPR-shaped share id', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const api = new EboksApi({
      digitalPostAccessToken: async () => 'dp-access',
      device,
      fetchImpl: async (url, init) => {
        const target = String(url);
        calls.push({ method: init?.method ?? 'GET', url: target });
        if (target.includes('usertoken')) return Response.json({ userToken: 'user-tok' });
        if (target.includes('oauth-dk.e-boks.com')) {
          return Response.json({ access_token: 'eboks-access', expires_in: 300 });
        }
        if (target.endsWith('/user/profile')) {
          return Response.json({ name: 'Test Person', identity: '0000000000' });
        }
        if (target.endsWith('/mail/shares')) {
          return Response.json([
            { userId: '0000000000', name: 'Hidden', status: 'Accepted' },
            { userId: '010190-1234', name: 'Dashed', status: 'Accepted' },
            {
              userId: 'share-1',
              name: 'Firma ApS',
              permission: 'Administration',
              status: 'Accepted',
            },
          ]);
        }
        if (target.endsWith('/mail/folders')) {
          return Response.json({
            folders: [
              {
                id: 'inbox',
                name: 'Indbakke',
                type: 'inbox',
                folders: [{ id: 'child', name: 'Bank', type: 'folder', folders: [] }],
              },
            ],
          });
        }
        if (target.includes('/messages?')) {
          return Response.json({
            items: [
              {
                id: 'msg-1',
                subject: 'Kontoudtog',
                sender: { name: 'Banken' },
                received: '2026-03-01T10:00:00Z',
                unread: true,
                numberOfAttachments: 0,
              },
            ],
            metadata: { total: 1 },
          });
        }
        return Response.json({
          id: 'msg-1',
          subject: 'Kontoudtog',
          sender: { name: 'Banken' },
          received: '2026-03-01T10:00:00Z',
          unread: true,
          attachments: [
            { id: 'a1', name: 'note.pdf', content: { mimeType: 'application/pdf', fileSize: 10 } },
          ],
        });
      },
    });

    const profile = await api.profile();
    expect(profile.name).toBe('Test Person');
    expect(JSON.stringify(profile)).not.toContain('0000000000');

    const shares = await api.shares();
    expect(shares.map((share) => share.userId)).toEqual(['share-1']);

    const folders = await api.listFolders();
    expect(folders.map((folder) => folder.id)).toEqual(['inbox', 'child']);
    expect(folders[1]?.parentId).toBe('inbox');

    const page = await api.listMessages('inbox', { limit: 5 });
    expect(page.messages[0]?.subject).toBe('Kontoudtog');
    expect(page.messages[0]?.sender).toBe('Banken');
    expect(page.total).toBe(1);
    const listCall = calls.find((call) => call.url.includes('/messages?'));
    expect(listCall?.url).toContain('limit=5');

    const one = await api.getMessage('inbox', 'msg-1');
    expect(one.attachments[0]?.filename).toBe('note.pdf');
    expect(JSON.stringify(one)).not.toContain('0000000000');

    const mailCalls = calls.filter((call) => call.url.includes('/2/mail'));
    expect(mailCalls.length).toBeGreaterThan(0);
    expect(mailCalls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('keeps numeric ids, the letter title, and retries once after HTTP 401', async () => {
    let foldersCalls = 0;
    let tokenCalls = 0;
    const api = new EboksApi({
      digitalPostAccessToken: async () => 'dp-access',
      device,
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.includes('usertoken')) return Response.json({ userToken: 'user-tok' });
        if (target.includes('oauth-dk.e-boks.com')) {
          tokenCalls += 1;
          return Response.json({ access_token: `eboks-${tokenCalls}`, expires_in: 300 });
        }
        if (target.endsWith('/mail/shares')) {
          return Response.json([
            { userId: 4401, name: 'Firma ApS', permission: 'Read', status: 'Accepted' },
            { userId: 4402, name: 'Afventer', status: 'Pending' },
            { userId: '0000000000', name: 'Hidden', status: 'Accepted' },
          ]);
        }
        if (target.endsWith('/mail/folders')) {
          foldersCalls += 1;
          if (foldersCalls === 1) return new Response('expired', { status: 401 });
          return Response.json([
            { id: 10, name: 'Indbakke', type: 'inbox', folders: [{ id: 11, name: 'Bank' }] },
          ]);
        }
        return Response.json({
          id: 99,
          content: { title: 'Kontoudtog', fileExtension: 'pdf' },
          sender: { name: 'Banken' },
          attachments: [{ id: 7, title: 'note.pdf', mimeType: 'application/pdf', fileSize: 10 }],
        });
      },
    });

    const shares = await api.shares();
    expect(shares.map((share) => share.userId)).toEqual(['4401']);

    const folders = await api.listFolders();
    expect(folders.map((folder) => folder.id)).toEqual(['10', '11']);
    expect(folders[1]?.parentId).toBe('10');
    expect(tokenCalls).toBe(2);

    const one = await api.getMessage('10', '99');
    expect('getContent' in api).toBe(false);
    expect(one.id).toBe('99');
    expect(one.subject).toBe('Kontoudtog');
    expect(one.attachments[0]).toEqual({
      id: '7',
      filename: 'note.pdf',
      mimeType: 'application/pdf',
      size: 10,
    });
  });

  test('refuses a CPR-shaped userId before any fetch', async () => {
    let called = false;
    const api = new EboksApi({
      digitalPostAccessToken: async () => 'dp-access',
      device,
      fetchImpl: async () => {
        called = true;
        return new Response('no');
      },
    });
    for (const userId of ['0101901234', '010190-1234', ' 0101901234 ']) {
      await expect(api.listFolders(userId)).rejects.toThrow(/CPR/);
      await expect(api.listMessages('inbox', { userId })).rejects.toThrow(/CPR/);
      await expect(api.getMessage('inbox', 'msg-1', userId)).rejects.toThrow(/CPR/);
    }
    expect(called).toBe(false);
  });

  test('downloads only the one content path that was asked for', async () => {
    const calls: string[] = [];
    const api = new EboksApi({
      digitalPostAccessToken: async () => 'dp-access',
      device,
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        const target = String(url);
        calls.push(`${init?.method ?? 'GET'} ${target}`);
        if (target.includes('usertoken')) return Response.json({ userToken: 'user-tok' });
        if (target.includes('oauth-dk.e-boks.com')) {
          return Response.json({ access_token: 'eboks-access', expires_in: 300 });
        }
        if (target.endsWith('/content')) {
          return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          });
        }
        return Response.json({ id: 'msg-1', subject: 'Note', attachments: [] });
      },
    });
    const body = await api.getMessageContent('inbox', 'msg-1');
    expect(body.markedRead).toBe(true);
    expect(body.bytes[0]).toBe(0x25);
    const file = await api.getAttachmentContent('inbox', 'msg-1', 'a1');
    expect(file.markedRead).toBe(true);
    const mail = calls.filter((call) => call.includes('/2/mail'));
    expect(mail).toEqual([
      expect.stringContaining('/mail/folders/inbox/messages/msg-1/content'),
      expect.stringContaining('/mail/folders/inbox/messages/msg-1/attachment/a1/content'),
    ]);
    expect(mail.every((call) => call.startsWith('GET '))).toBe(true);
    expect(mail.some((call) => /POST|PUT|PATCH|DELETE/.test(call))).toBe(false);
  });

  test('coalesces concurrent exchanges so a single-use usertoken is not spent twice', async () => {
    const used = new Set<string>();
    let userTokenCalls = 0;
    let tokenCalls = 0;
    const api = new EboksApi({
      digitalPostAccessToken: async () => 'dp-access',
      device,
      fetchImpl: async (url, init) => {
        const target = String(url);
        if (target.includes('usertoken')) {
          userTokenCalls += 1;
          // Overlap the three discover-style callers before any token POST finishes.
          await new Promise((resolve) => setTimeout(resolve, 30));
          return Response.json({ userToken: 'same-user-tok' });
        }
        if (target.includes('oauth-dk.e-boks.com')) {
          tokenCalls += 1;
          const usertoken = new URLSearchParams(String(init?.body ?? '')).get('usertoken') ?? '';
          if (used.has(usertoken)) {
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          }
          used.add(usertoken);
          return Response.json({ access_token: 'eboks-access', expires_in: 300 });
        }
        if (target.endsWith('/user/profile')) return Response.json({ name: 'Test Person' });
        if (target.endsWith('/mail/folders')) return Response.json([]);
        if (target.endsWith('/mail/shares')) return Response.json([]);
        return new Response(null, { status: 404 });
      },
    });

    const [profile, folders, shares] = await Promise.all([
      api.profile(),
      api.listFolders(),
      api.shares(),
    ]);
    expect(profile.name).toBe('Test Person');
    expect(folders).toEqual([]);
    expect(shares).toEqual([]);
    expect(userTokenCalls).toBe(1);
    expect(tokenCalls).toBe(1);
  });

  test('content helpers are GET-only and do not undo the read mark', () => {
    const source = readFileSync(new URL('./eboks-api.ts', import.meta.url), 'utf8');
    expect(source).toContain('/content');
    expect(source).not.toMatch(/MessagePatch/);
    expect(source).not.toMatch(/"unread"\s*:/);
    for (const line of source.split('\n')) {
      if (line.includes('/mail/') && /POST|PUT|PATCH|DELETE/.test(line)) {
        throw new Error(line);
      }
    }
  });
});
