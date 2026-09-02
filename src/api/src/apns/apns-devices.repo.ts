/**
 * CRUD for `apns_device_tokens` rows (#1025). Registration is per (user,
 * device) — NOT per library. A File Provider domain is one per connected
 * SERVER (`FileProviderDomainController.domainIdentifier(for:)` keys on
 * scheme+host+port only), and every library registered on that server
 * surfaces as a sub-tree inside that one domain
 * (`FileProviderIdentifier.folder(folderID:relativePath:)` addresses a
 * library's contents as an ITEM within the domain, not a domain of its
 * own). So a device holds exactly one push registration per server it has
 * mounted, and a change to any library on that server should wake it —
 * there is no per-library push channel to scope to on the Apple side.
 */

import type { ObjectId } from 'mongodb';
import { apnsDeviceTokensCollection } from '../db/client.ts';
import type { ApnsDeviceTokenWithId, ApnsEnvironment } from '../db/schema.ts';

/**
 * APNs device tokens are hex-encoded bytes (`PKPushCredentials.token`,
 * hex-formatted client-side): exactly 64 hex characters for the modern
 * 32-byte token, which is the only format any Maple client can ever send
 * — the deployment floor is iOS 26.0 / macOS 14.0, well past any of
 * Apple's historical shorter/variable-length token eras, so there is no
 * legacy shape to stay lenient for. Trims whitespace and lowercases
 * before validating so `AbCd…` and `abcd…` (or a trailing newline pasted
 * into a debug tool) register as the SAME device rather than silently
 * creating a second stored row that never matches what APNs reports back
 * on prune. Returns `null` for anything that doesn't look like a real
 * token — callers turn that into a 400 rather than storing a malformed
 * value APNs will just keep rejecting.
 */
const DEVICE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function normalizeDeviceToken(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  return DEVICE_TOKEN_PATTERN.test(normalized) ? normalized : null;
}

export interface RegisterDeviceInput {
  userId: ObjectId;
  deviceToken: string;
  platform: 'ios' | 'macos';
  environment: ApnsEnvironment;
}

/** Upsert on the natural key (user, device) — a re-registration (app
 * relaunch, token refresh with the same value) updates `updated_at` and
 * any changed platform/environment rather than duplicating. */
export async function registerDeviceToken(input: RegisterDeviceInput): Promise<void> {
  const coll = await apnsDeviceTokensCollection();
  const now = new Date();
  await coll.updateOne(
    { user_id: input.userId, device_token: input.deviceToken },
    {
      $set: {
        platform: input.platform,
        environment: input.environment,
        updated_at: now,
      },
      $setOnInsert: {
        user_id: input.userId,
        device_token: input.deviceToken,
        created_at: now,
      },
    },
    { upsert: true },
  );
}

export interface UnregisterDeviceInput {
  userId: ObjectId;
  deviceToken: string;
}

/** Returns the number of rows removed (0 or 1 — the natural key is
 * unique). */
export async function unregisterDeviceToken(input: UnregisterDeviceInput): Promise<number> {
  const coll = await apnsDeviceTokensCollection();
  const res = await coll.deleteMany({
    user_id: input.userId,
    device_token: input.deviceToken,
  });
  return res.deletedCount;
}

/** Remove device tokens by value alone, across every user — used when
 * APNs itself reports one or more tokens as permanently invalid
 * (`shouldPrune`). No user scoping: an unregistered token is dead
 * regardless of who registered it. Takes an array (rather than one call
 * per token) so a burst that fans out to many devices prunes with a
 * single `deleteMany` instead of one round trip per rejected device. A
 * no-op on an empty array (skips the round trip entirely). */
export async function pruneDeviceTokens(deviceTokens: string[]): Promise<number> {
  if (deviceTokens.length === 0) return 0;
  const coll = await apnsDeviceTokensCollection();
  const res = await coll.deleteMany({ device_token: { $in: deviceTokens } });
  return res.deletedCount;
}

export async function listDeviceTokensForUser(userId: ObjectId): Promise<ApnsDeviceTokenWithId[]> {
  const coll = await apnsDeviceTokensCollection();
  return coll.find({ user_id: userId }).sort({ updated_at: -1 }).toArray();
}

/** Every device registered on this server — this is the push trigger's
 * fan-out list for one coalesced change burst (any library, since a
 * device's one push registration covers the whole server). */
export async function listAllDeviceTokens(): Promise<ApnsDeviceTokenWithId[]> {
  const coll = await apnsDeviceTokensCollection();
  return coll.find({}).toArray();
}
