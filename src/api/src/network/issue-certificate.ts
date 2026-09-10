import { Client, crypto, directory, axios } from 'acme-client';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import type { ManagedHttpsConfig } from './managed-https-config.ts';
import { CloudflareDns } from './cloudflare-dns.ts';
import {
  readCertificateState,
  writeCertificateState,
  rememberChallenge,
  forgetChallenge,
  type StoredCertificate,
} from './certificate-store.ts';

// acme-client's HTTP client is private to that package; bound every external
// request so a dead ACME connection cannot hold the renewal lease forever.
axios.defaults.timeout = 15_000;

export async function issueCertificate(config: ManagedHttpsConfig): Promise<StoredCertificate> {
  const dns = new CloudflareDns(config);
  await dns.checkZone();
  const state = await readCertificateState();
  // Resume cleanup after a process crash before creating a new challenge.
  for (const record of state?.challenges ?? []) {
    await dns.remove(record.zone_id, record.id);
    await forgetChallenge(record);
  }
  const accountKey = state?.account_key ?? (await crypto.createPrivateKey()).toString();
  await writeCertificateState({ account_key: accountKey });
  const client = new Client({
    directoryUrl: directory.letsencrypt.production,
    accountKey,
    backoffAttempts: 8,
    backoffMin: 2000,
    backoffMax: 5000,
  });
  const [key, csr] = await crypto.createCsr({ commonName: config.hostname });
  const records = new Map<string, { id: string; zone_id: string }>();
  try {
    const cert = await client.auto({
      csr,
      email: config.email,
      termsOfServiceAgreed: config.terms_agreed,
      challengePriority: ['dns-01'],
      skipChallengeVerification: true,
      challengeCreateFn: async (authz, challenge, value) => {
        if (challenge.type !== 'dns-01' || authz.identifier.value !== config.hostname)
          throw new Error(
            'Unexpected ACME challenge. Only this hostname’s DNS-01 challenge is allowed.',
          );
        const record = { id: await dns.create(value), zone_id: config.zone_id };
        records.set(challenge.url, record);
        await rememberChallenge(record);
        await dns.waitForPropagation(value);
      },
      // Cleanup runs in our finally too, including create/propagation failures.
      challengeRemoveFn: async (_authz, challenge) => {
        const record = records.get(challenge.url);
        if (!record) return;
        await dns.remove(record.zone_id, record.id);
        await forgetChallenge(record);
        records.delete(challenge.url);
      },
    });
    const parsed = new X509Certificate(cert);
    if (
      !parsed.checkHost(config.hostname, { wildcards: false }) ||
      !parsed.checkPrivateKey(createPrivateKey(key))
    )
      throw new Error('Issued certificate does not match the requested hostname and private key.');
    const issued = {
      hostname: config.hostname,
      key: key.toString(),
      cert,
      not_before: Date.parse(parsed.validFrom),
      not_after: Date.parse(parsed.validTo),
    };
    // Keep a successfully issued certificate even if DNS cleanup later fails;
    // retrying cleanup must never create duplicate ACME orders.
    await writeCertificateState({ certificate: issued });
    return issued;
  } finally {
    for (const record of records.values()) {
      await dns.remove(record.zone_id, record.id);
      await forgetChallenge(record);
    }
  }
}
