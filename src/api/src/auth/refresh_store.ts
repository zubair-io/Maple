import { ObjectId } from 'mongodb';
import { refreshTokensCollection } from '../db/client.ts';
import { generateRefreshToken, hashRefreshToken, refreshExpiresAt } from './tokens.ts';

export interface IssuedRefresh {
  raw: string;
  userId: ObjectId;
  familyId: ObjectId;
}

export type RefreshErrorCode =
  | 'unknown_token'
  | 'token_expired'
  | 'rotation_conflict'
  | 'reuse_detected';

export class RefreshError extends Error {
  constructor(
    public readonly code: RefreshErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RefreshError';
  }
}

/**
 * Lost-response / concurrent-rotation grace window (#858).
 *
 * A just-rotated (revoked) token replayed within this window — *while its
 * family still has a live token* — is treated as a benign retry and re-minted,
 * NOT as theft. This is what stops the original "refresh token reuse detected —
 * chain revoked" logout: a refresh whose response was lost (or a concurrent
 * multi-tab/in-flight refresh) replays the old token and recovers instead of
 * nuking the session.
 *
 * It bounds the theft-detection gap to ~this window and pairs with the
 * short-access-TTL pivot (#860). It covers concurrent refreshes and quick
 * reloads; a lost response followed by a delayed return (minutes later) still
 * lands outside the window and requires a re-login — an acceptable, safe
 * outcome for a long-dormant tab.
 */
export const REFRESH_GRACE_MS = 60_000;

/**
 * Issue a refresh token. Omitting `familyId` starts a NEW family (a fresh login
 * / device); a rotation passes the parent token's family so the whole lineage
 * is tracked together and can be revoked as a unit.
 */
export async function issueRefreshToken(
  userId: ObjectId,
  deviceLabel: string,
  familyId?: ObjectId,
  platform?: string,
): Promise<IssuedRefresh> {
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
  });
  return { raw, userId, familyId: family };
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
    const successorFamily = matched.family_id ?? new ObjectId();
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
    });
    return { raw: successorRaw, userId: matched.user_id, familyId: successorFamily };
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
      return await issueRefreshToken(row.user_id, row.device_label, row.family_id, row.platform);
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

/** Revoke a single token by its raw value. */
export async function revokeOne(rawToken: string): Promise<void> {
  const c = await refreshTokensCollection();
  await c.updateOne(
    { token_hash: hashRefreshToken(rawToken), revoked_at: null },
    { $set: { revoked_at: new Date().toISOString() } },
  );
}
