import { describe, expect, test } from 'bun:test';
import type { Session } from './session.ts';
import { MAIL_READ_NOTE, readAccountStatus } from './status.ts';

describe('account status', () => {
  test('is read-only until e-Boks content tools are enabled', async () => {
    const session = {
      async status() {
        return null;
      },
    } as Session;
    const plain = await readAccountStatus({
      session,
      listMailboxes: async () => [],
      eboksRegistered: false,
      eboksContentEnabled: false,
    });
    expect(plain.readOnly).toBe(true);
    expect(plain.note).toBe(MAIL_READ_NOTE);

    const withContent = await readAccountStatus({
      session,
      listMailboxes: async () => [],
      eboksRegistered: true,
      eboksContentEnabled: true,
    });
    expect(withContent.readOnly).toBe(false);
    expect(withContent.note).toBe(
      'Digital Post never marks read; e-Boks content download marks the e-Boks letter read.',
    );
    expect(JSON.stringify(withContent)).not.toContain('accessToken');
  });
});
