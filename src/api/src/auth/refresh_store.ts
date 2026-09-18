import { ObjectId, type Collection, type WithId } from 'mongodb';
import { refreshTokensCollection } from '../db/client.ts';
import type { RefreshTokenDoc } from '../db/schema.ts';
import { generateRefreshToken, hashRefreshToken, refreshExpiresAt } from './tokens.ts';

// The error class, its codes, the grace window and the option/result shapes
// moved to `./refresh-contract.ts` when the SQLite store (#3751) became a
// second implementation. `routes/auth.ts` picks a status code with
// `err instanceof RefreshError`, so both stores have to throw the one class —
// two classes of the same name would make that check depend on which store
// answered. Re-exported here so every existing importer is unaffected.
export {
  RefreshError,
  REFRESH_GRACE_MS,
  type IssuedRefresh,
  type IssueRefreshTokenOptions,
} from './refresh-contract.ts';

import {
  RefreshError,
  REFRESH_GRACE_MS,
  type IssuedRefresh,
  type IssueRefreshTokenOptions,
} from './refresh-contract.ts';

/** Issue a refresh token. See `IssueRefreshTokenOptions` for the optional lineage/platform/secure knobs. */
export async function issueRefreshToken(
  userId: ObjectId,
  deviceLabel: string,
  opts: IssueRefreshTokenOptions = {},
): Promise<IssuedRefresh> {
  const { familyId, platform, secure = true } = opts;
  const raw = generateRefreshToken();
  const family = familyId ?? new ObjectId();
  const c = await refreshTokensCollection();
  await c.insertOne({
    user_id: userId,
    token_hash: hashRefreshToken(raw),
    issued_at: new Date().toISOString(),
    expires_at: refreshExpiresAt(),
    revoked_at: null,
    replaced_by: null,
    device_label: deviceLabel,
    family_id: family,
    ...(platform !== undefined ? { platform } : {}),
    secure,
  });
  return { raw, userId, familyId: family, secure };
}

/** Inserts the CAS-linked successor row for a live token rotation and
 * returns it, carrying `platform`/`secure` forward from the rotated token. */
async function mintSuccessor(
  c: Collection<RefreshTokenDoc>,
  matched: WithId<RefreshTokenDoc>,
  successorId: ObjectId,
  successorRaw: string,
  now: Date,
): Promise<IssuedRefresh> {
  const successorFamily = matched.family_id ?? new ObjectId();
  const secure = matched.secure ?? true;
  await c.insertOne({
    _id: successorId,
    user_id: matched.user_id,
    token_hash: hashRefreshToken(successorRaw),
    issued_at: now.toISOString(),
    expires_at: refreshExpiresAt(),
    revoked_at: null,
    replaced_by: null,
    device_label: matched.device_label,
    family_id: successorFamily,
    ...(matched.platform !== undefined ? { platform: matched.platform } : {}),
    secure,
  });
  return { raw: successorRaw, userId: matched.user_id, familyId: successorFamily, secure };
}

/**
 * Rotate a refresh token.
 *
 *  1. Atomic CAS — consume the token IFF it is live (unrevoked, unexpired) and
 *     link the successor in the same `$set`, so a concurrent rotation can never
 *     observe a revoked-but-unlinked row (closes the read-check-write TOCTOU).
 *  2. No live match → classify: unknown / expired.
 *  3. Revoked + within grace + family still has a live token → benign retry →
 *     re-mint in the same family.
 *  4. Revoked + within grace but family is dead (logout / already revoked) → a
 *     race or a logged-out token → reject WITHOUT revoking (don't kill a racing
 *     successor; the client retries and self-heals).
 *  5. Revoked + outside grace → genuine reuse → revoke the whole family.
 */
export async function rotateRefreshToken(rawOld: string): Promise<IssuedRefresh> {
  const c = await refreshTokensCollection();
  const oldHash = hashRefreshToken(rawOld);
  const now = new Date();

  // Pre-generate the successor so `replaced_by` is linked atomically by the CAS.
  const successorId = new ObjectId();
  const successorRaw = generateRefreshToken();

  // 1. Atomic compare-and-swap.
  const matched = await c.findOneAndUpdate(
    { token_hash: oldHash, revoked_at: null, expires_at: { $gt: now } },
    { $set: { revoked_at: now.toISOString(), replaced_by: successorId } },
  );
  if (matched) {
    return await mintSuccessor(c, matched, successorId, successorRaw, now);
  }

  // 2. Not live — classify.
  const row = await c.findOne({ token_hash: oldHash });
  if (!row) throw new RefreshError('unknown_token', 'unknown refresh token');
  if (row.revoked_at === null) throw new RefreshError('token_expired', 'refresh token expired');

  // 3/4. Revoked + within grace.
  if (now.getTime() - new Date(row.revoked_at).getTime() <= REFRESH_GRACE_MS) {
    if (row.family_revoked_at) {
      throw new RefreshError('reuse_detected', 'refresh token family revoked');
    }
    const live = row.family_id
      ? await c.findOne({ family_id: row.family_id, revoked_at: null })
      : null;
    if (live) {
      // Benign lost-response / concurrent retry of a just-rotated token.
      return await issueRefreshToken(row.user_id, row.device_label, {
        familyId: row.family_id,
        platform: row.platform,
        secure: row.secure ?? true,
      });
    }
    // A winning CAS linked its successor but has not inserted it yet. The
    // family has not been deliberately revoked, so this is transient.
    throw new RefreshError('rotation_conflict', 'refresh token rotation conflict');
  }

  // 5. Revoked + outside grace → genuine reuse → kill this device's family.
  if (row.family_id) {
    await revokeFamily(row.family_id);
  } else {
    // Legacy token issued before family tracking — fall back to per-user.
    await revokeChain(row.user_id);
  }
  throw new RefreshError('reuse_detected', 'refresh token reuse detected — family revoked');
}

/** Revoke every live token in a family (one device's rotation lineage). */
export async function revokeFamily(familyId: ObjectId): Promise<void> {
  const c = await refreshTokensCollection();
  const revokedAt = new Date().toISOString();
  await c.updateMany({ family_id: familyId }, { $set: { family_revoked_at: revokedAt } });
  await c.updateMany(
    { family_id: familyId, revoked_at: null },
    { $set: { revoked_at: revokedAt } },
  );
}

/**
 * Revoke the whole family a given raw token belongs to — used by logout so the
 * device's entire lineage signs out, not just the one presented token.
 */
export async function revokeFamilyByToken(rawToken: string): Promise<void> {
  const c = await refreshTokensCollection();
  const row = await c.findOne({ token_hash: hashRefreshToken(rawToken) });
  if (!row) return;
  if (row.family_id) {
    await revokeFamily(row.family_id);
  } else {
    const revokedAt = new Date().toISOString();
    await c.updateOne(
      { _id: row._id },
      { $set: { revoked_at: revokedAt, family_revoked_at: revokedAt } },
    );
  }
}

/**
 * Revoke every live refresh family for a user (deliberate "log out everywhere").
 *
 * Access tokens are stateless (no per-request DB check), so an already-issued
 * access token stays valid until its short (15-min) TTL expires; once it does,
 * the revoked refresh can't renew it and the session ends.
 */
export async function revokeChain(userId: ObjectId): Promise<void> {
  const c = await refreshTokensCollection();
  const revokedAt = new Date().toISOString();
  await c.updateMany({ user_id: userId }, { $set: { family_revoked_at: revokedAt } });
  await c.updateMany({ user_id: userId, revoked_at: null }, { $set: { revoked_at: revokedAt } });
}

export interface DeviceSession {
  id: string;
  label: string;
  platform: string;
  created_at: string;
  last_used_at: string;
}

/**
 * Live paired-device families for a user. A "device session" is a refresh
 * family carrying a `platform` marker (stamped only by the device-sessions
 * mint endpoint) — ordinary logins never set it, so they never appear here.
 * "Live" = the family still holds an unrevoked, unexpired token.
 */
export async function listDeviceSessions(userId: ObjectId): Promise<DeviceSession[]> {
  const c = await refreshTokensCollection();
  const now = new Date();
  const rows = await c
    .aggregate<{
      _id: ObjectId;
      label: string;
      platform: string;
      created_at: string;
      last_used_at: string;
      live: number;
    }>([
      {
        $match: {
          user_id: userId,
          platform: { $exists: true },
          family_revoked_at: { $exists: false },
        },
      },
      {
        $group: {
          _id: '$family_id',
          label: { $first: '$device_label' },
          platform: { $first: '$platform' },
          created_at: { $min: '$issued_at' },
          last_used_at: { $max: '$issued_at' },
          live: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$revoked_at', null] }, { $gt: ['$expires_at', now] }] },
                1,
                0,
              ],
            },
          },
        },
      },
      { $match: { live: { $gt: 0 } } },
      { $sort: { last_used_at: -1 } },
    ])
    .toArray();
  return rows.map((r) => ({
    id: r._id.toHexString(),
    label: r.label,
    platform: r.platform,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
  }));
}

/**
 * Revoke one paired-device family, ownership-checked. Only platform-marked
 * families qualify — the panel must not be able to kill an ordinary login's
 * family through this path (logout and revokeChain cover those).
 */
export async function revokeDeviceSession(userId: ObjectId, familyId: ObjectId): Promise<boolean> {
  const c = await refreshTokensCollection();
  const row = await c.findOne({
    family_id: familyId,
    user_id: userId,
    platform: { $exists: true },
  });
  if (!row) return false;
  await revokeFamily(familyId);
  return true;
}
