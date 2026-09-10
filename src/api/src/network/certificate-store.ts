/** Internal certificate/account state. No HTTP route serializes this row. */
import { getDb } from '../db/client.ts';

export interface StoredCertificate {
  hostname: string;
  key: string;
  cert: string;
  not_before: number;
  not_after: number;
}
export interface DnsChallengeRecord {
  id: string;
  zone_id: string;
}
interface CertificateState {
  _id: string;
  account_key?: string;
  certificate?: StoredCertificate;
  challenges?: DnsChallengeRecord[];
  lease_owner?: string;
  lease_until?: number;
  retry_after?: number;
  attempted_revision?: string;
}
async function collection() {
  return (await getDb()).collection<CertificateState>('managed_certificates');
}
export async function readCertificateState() {
  return (await collection()).findOne({ _id: 'lan' });
}
export async function writeCertificateState(patch: Partial<Omit<CertificateState, '_id'>>) {
  await (await collection()).updateOne({ _id: 'lan' }, { $set: patch }, { upsert: true });
}
export async function claimCertificateLease(owner: string): Promise<boolean> {
  const coll = await collection();
  await coll.updateOne({ _id: 'lan' }, { $setOnInsert: { lease_until: 0 } }, { upsert: true });
  const result = await coll.updateOne(
    {
      _id: 'lan',
      $or: [{ lease_until: { $lte: Date.now() } }, { lease_until: { $exists: false } }],
    },
    { $set: { lease_owner: owner, lease_until: Date.now() + 10 * 60_000 } },
  );
  return result.modifiedCount === 1;
}
export async function renewCertificateLease(owner: string): Promise<boolean> {
  const result = await (
    await collection()
  ).updateOne(
    { _id: 'lan', lease_owner: owner },
    { $set: { lease_until: Date.now() + 10 * 60_000 } },
  );
  return result.matchedCount === 1;
}
export async function releaseCertificateLease(owner: string) {
  await (
    await collection()
  ).updateOne({ _id: 'lan', lease_owner: owner }, { $set: { lease_until: 0 } });
}
export async function rememberChallenge(record: DnsChallengeRecord) {
  await (await collection()).updateOne({ _id: 'lan' }, { $push: { challenges: record } });
}
export async function forgetChallenge(record: DnsChallengeRecord) {
  await (await collection()).updateOne({ _id: 'lan' }, { $pull: { challenges: record } });
}

/** Renew at two thirds of the actual lifetime, at most 30 days before expiry.
 * Does not assume Let's Encrypt certificates always last 90 days. */
export function renewalTime(cert: StoredCertificate): number {
  return cert.not_after - Math.min(30 * 86400_000, (cert.not_after - cert.not_before) / 3);
}
