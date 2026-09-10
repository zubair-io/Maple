import { afterAll, beforeAll, expect, it, spyOn } from 'bun:test';
import { Client } from 'acme-client';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { closeDb, getDb } from '../db/client.ts';
import { CloudflareDns } from './cloudflare-dns.ts';
import { DEFAULT_HTTPS } from './managed-https-config.ts';
import { readCertificateState } from './certificate-store.ts';
import { issueCertificate } from './issue-certificate.ts';

let mongo: MongoMemoryServer;
let originalEnv: { uri: string | undefined; db: string | undefined };
beforeAll(async () => {
  originalEnv = { uri: process.env.MAPLE_MONGO_URI, db: process.env.MAPLE_MONGO_DB };
  mongo = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
  process.env.MAPLE_MONGO_URI = mongo.getUri();
  process.env.MAPLE_MONGO_DB = `https_issuance_test_${process.pid}`;
}, 60_000);
afterAll(async () => {
  await closeDb();
  await mongo?.stop();
  for (const [key, value] of Object.entries({
    MAPLE_MONGO_URI: originalEnv.uri,
    MAPLE_MONGO_DB: originalEnv.db,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it('preserves the order error and attempts every cleanup, retaining failed records for retry', async () => {
  await (await getDb()).dropDatabase();
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
