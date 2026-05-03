import { ObjectId } from "mongodb";
import { refreshTokensCollection } from "../db/client.ts";
import { generateRefreshToken, hashRefreshToken, refreshExpiresAt } from "./tokens.ts";

export interface IssuedRefresh { raw: string; userId: ObjectId; }

export async function issueRefreshToken(
  userId: ObjectId,
  deviceLabel: string
): Promise<IssuedRefresh> {
  const raw = generateRefreshToken();
  const c = await refreshTokensCollection();
  await c.insertOne({
    user_id: userId,
    token_hash: hashRefreshToken(raw),
    issued_at: new Date().toISOString(),
    expires_at: refreshExpiresAt(),
    revoked_at: null,
    replaced_by: null,
    device_label: deviceLabel,
  });
  return { raw, userId };
}

export async function rotateRefreshToken(rawOld: string): Promise<IssuedRefresh> {
  const c = await refreshTokensCollection();
  const hash = hashRefreshToken(rawOld);
  const row = await c.findOne({ token_hash: hash });
  if (!row) throw new Error("unknown refresh token");

  if (row.revoked_at !== null) {
    // Reuse → kill the entire chain (walk forward via replaced_by + walk backward by following chain).
    await revokeChain(row.user_id);
    throw new Error("refresh token reuse detected — chain revoked");
  }

  if (row.expires_at.getTime() < Date.now()) {
    throw new Error("refresh token expired");
  }

  const fresh = await issueRefreshToken(row.user_id, row.device_label);
  await c.updateOne(
    { _id: row._id },
    { $set: { revoked_at: new Date().toISOString(), replaced_by: (await c.findOne({ token_hash: hashRefreshToken(fresh.raw) }))!._id } }
  );
  return fresh;
}

export async function revokeChain(userId: ObjectId): Promise<void> {
  const c = await refreshTokensCollection();
  await c.updateMany(
    { user_id: userId, revoked_at: null },
    { $set: { revoked_at: new Date().toISOString() } }
  );
}

export async function revokeOne(rawToken: string): Promise<void> {
  const c = await refreshTokensCollection();
  await c.updateOne(
    { token_hash: hashRefreshToken(rawToken), revoked_at: null },
    { $set: { revoked_at: new Date().toISOString() } }
  );
}
