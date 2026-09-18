/**
 * Internal certificate/account state. No HTTP route serializes this row.
 *
 * The ACME account key, the issued LAN certificate and any in-flight DNS-01
 * challenges live in one row of `managed_certificates`. Every query moved to
 * `db/sqlite/repos/managed-certificates.repo.ts` (#3787) and is re-exported
 * below one name at a time, so a signature that changed on the SQLite side
 * breaks the build here instead of being substituted silently.
 *
 * {@link renewalTime} stays: it is arithmetic over a certificate's validity
 * window with no database in it.
 */

import type { StoredCertificate } from '../db/sqlite/repos/managed-certificates.repo.ts';

export {
  claimCertificateLease,
  forgetChallenge,
  readCertificateState,
  releaseCertificateLease,
  rememberChallenge,
  renewCertificateLease,
  writeCertificateState,
  type CertificateState,
  type DnsChallengeRecord,
  type StoredCertificate,
} from '../db/sqlite/repos/managed-certificates.repo.ts';

/** Renew at two thirds of the actual lifetime, at most 30 days before expiry.
 * Does not assume Let's Encrypt certificates always last 90 days. */
export function renewalTime(cert: StoredCertificate): number {
  return cert.not_after - Math.min(30 * 86400_000, (cert.not_after - cert.not_before) / 3);
}
