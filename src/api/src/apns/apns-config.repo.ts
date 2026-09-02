/**
 * Persisted APNs push-to-signal config. A single document in `app_settings`
 * keyed by `_id: "apns"`, mirroring the shape used by
 * `network/network-config.repo.ts`.
 *
 * Surfaced on Settings → Network alongside the LAN-address override (#1025):
 * this is the operator-facing on/off switch for the File Provider's push
 * channel. The default is OFF — most self-hosted operators have no Apple
 * Developer Program membership and therefore no APNs credentials, so
 * shipping this defaulted-on would silently do nothing (or, once
 * credentials appear later, silently start doing something the operator
 * never opted into). SSE remains the change-feed path whenever this is off
 * or credentials are missing; see `apns/push-trigger.ts`.
 *
 * Unlike the `enabled` toggle, APNs credentials (the `.p8` key, key id, team
 * id) are NOT stored here. Per CLAUDE.md's "configure via the settings
 * system" rule, they are the one documented exception: they're a deploy
 * secret that must exist before this feature can do anything, in the same
 * category as `MAPLE_JWT_SECRET_FILE` or `MAPLE_TLS_CERT` — so they live in
 * environment variables (`loadApnsCredentialsFromEnv` below), and this
 * document only ever holds the boolean the operator controls at runtime.
 */

import { getDb } from '../db/client.ts';

const COLL = 'app_settings';
const DOC_ID = 'apns';

export interface ApnsSettingsConfig {
  /** Operator opt-in. `null`/missing → resolver default `false`. */
  enabled?: boolean | null;
  updated_at?: number;
}

interface ApnsSettingsDoc {
  _id: string;
  config: ApnsSettingsConfig;
}

export interface ResolvedApnsSettingsConfig {
  enabled: boolean;
}

/** Read the persisted config. Returns `null` when no row exists yet. */
export async function loadApnsSettingsConfig(): Promise<ApnsSettingsConfig | null> {
  try {
    const db = await getDb();
    const doc = await db.collection<ApnsSettingsDoc>(COLL).findOne({ _id: DOC_ID });
    return doc?.config ?? null;
  } catch {
    return null;
  }
}

/** Upsert. Partial patches are supported: only supplied fields are touched,
 * except `updated_at`, which always bumps to `Date.now()` on every call —
 * same convention as `network-config.repo.ts`'s `saveNetworkConfig` and
 * `cloudflare-config.repo.ts`'s `saveCloudflareConfig`. */
export async function saveApnsSettingsConfig(patch: Partial<ApnsSettingsConfig>): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = {
    'config.updated_at': Date.now(),
  };
  if (patch.enabled !== undefined) set['config.enabled'] = patch.enabled;
  await db
    .collection<ApnsSettingsDoc>(COLL)
    .updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
}

/** Resolve the effective config. Pure function of the DB doc — default off. */
export function resolveApnsSettingsConfig(
  db: ApnsSettingsConfig | null,
): ResolvedApnsSettingsConfig {
  return { enabled: typeof db?.enabled === 'boolean' ? db.enabled : false };
}

// ---------------------------------------------------------------------------
// Credentials — env vars, per CLAUDE.md's deploy-secret exception.
// ---------------------------------------------------------------------------

export interface ApnsEnvCredentials {
  /** The 10-character APNs Auth Key id (Certificates, Identifiers & Profiles
   * → Keys). */
  keyId: string;
  /** The 10-character Apple Developer Team id. */
  teamId: string;
  /** PEM contents of the `.p8` token-signing key (PKCS#8, EC private key). */
  privateKeyPem: string;
}

/**
 * Read APNs provider-auth credentials from the environment:
 *   MAPLE_APNS_KEY_ID          — the Auth Key id
 *   MAPLE_APNS_TEAM_ID         — the Apple Developer Team id
 *   MAPLE_APNS_PRIVATE_KEY     — PEM contents of the .p8 key. Most secret
 *                                 managers and `.env` files can't hold a
 *                                 literal newline, so a value containing the
 *                                 two-character escape `\n` is unescaped to a
 *                                 real newline before use (same convention as
 *                                 e.g. GOOGLE_APPLICATION_CREDENTIALS-style
 *                                 PEM env vars elsewhere in the ecosystem).
 *
 * Returns `null` when any of the three is unset — the feature stays fully
 * inert (falls back to SSE) rather than throwing, since this is read on
 * every coalesced push attempt, not once at boot.
 */
export function loadApnsCredentialsFromEnv(): ApnsEnvCredentials | null {
  const keyId = process.env.MAPLE_APNS_KEY_ID;
  const teamId = process.env.MAPLE_APNS_TEAM_ID;
  const rawKey = process.env.MAPLE_APNS_PRIVATE_KEY;
  if (!keyId || !teamId || !rawKey) return null;
  const privateKeyPem = rawKey.replace(/\\n/g, '\n');
  return { keyId, teamId, privateKeyPem };
}

/** Cheap boolean the settings route can report without handing the actual
 * key material back to the browser. */
export function hasApnsCredentials(): boolean {
  return loadApnsCredentialsFromEnv() !== null;
}
