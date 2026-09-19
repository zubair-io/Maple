/**
 * ACME issuance persists the account key and every in-flight DNS-01 challenge
 * to the single `managed_certificates` row, through `network/certificate-store.ts`
 * and the repository behind it. `issueCertificate` reaches that row with no
 * database argument, so the test installs one as the process-wide handle for the
 * duration of the case (#3787).
 *
 * A fresh database per case replaces what used to be a downloaded mongod plus a
 * `dropDatabase()` on the way in: a migrated in-memory database costs
 * milliseconds, and it is empty by construction rather than by being emptied.
 */

import { expect, it, spyOn } from 'bun:test';
import { Client } from 'acme-client';
import { CloudflareDns } from './cloudflare-dns.ts';
import { DEFAULT_HTTPS } from './managed-https-config.ts';
import { readCertificateState } from './certificate-store.ts';
import { issueCertificate } from './issue-certificate.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';

it('preserves the order error and attempts every cleanup, retaining failed records for retry', async () => {
  using _live = await createLiveTestDatabase();
  const config = { ...DEFAULT_HTTPS, hostname: 'local.example.com', zone_id: 'a'.repeat(32) };
  const first = 'b'.repeat(32);
  const second = 'c'.repeat(32);
  const orderError = new Error('order failed');
  const zone = spyOn(CloudflareDns.prototype, 'checkZone').mockResolvedValue();
  const create = spyOn(CloudflareDns.prototype, 'create')
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second);
  const propagation = spyOn(CloudflareDns.prototype, 'waitForPropagation').mockResolvedValue();
  const remove = spyOn(CloudflareDns.prototype, 'remove')
    .mockRejectedValueOnce(new Error('cleanup failed'))
    .mockResolvedValue();
  const auto = spyOn(Client.prototype, 'auto').mockImplementation(async (options) => {
    for (const url of ['first-challenge', 'second-challenge']) {
      await options.challengeCreateFn!(
        {
          url: 'test-authorization',
          identifier: { type: 'dns', value: config.hostname },
          status: 'pending',
          challenges: [],
        },
        { type: 'dns-01', url, status: 'pending', token: 'test-token' },
        'txt-value',
      );
    }
    throw orderError;
  });
  try {
    await expect(issueCertificate(config)).rejects.toBe(orderError);
    expect(remove.mock.calls).toEqual([
      [config.zone_id, first],
      [config.zone_id, second],
    ]);
    expect((await readCertificateState())?.challenges).toEqual([
      { zone_id: config.zone_id, id: first },
    ]);
  } finally {
    auto.mockRestore();
    remove.mockRestore();
    propagation.mockRestore();
    create.mockRestore();
    zone.mockRestore();
  }
});
