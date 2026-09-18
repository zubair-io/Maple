// LAN handoff one-time code store.
//
// A signed-in web session on the public URL mints a short-TTL, single-use
// code; the SAME browser redeems it moments later on the server's LAN
// address (after `window.location` navigates there) for a fresh session —
// without repeating the WebAuthn ceremony, which requires a secure context
// the plain-HTTP LAN origin can't provide. See routes/auth-lan-handoff.ts.
//
// No PKCE (unlike native_code_store.ts): the native flow keeps the verifier
// in the app's memory, only sending the CODE over the transport an attacker
// could intercept. Here there's no such side-channel — code and any verifier
// would travel together in the same redirect URL — so a bare single-use,
// short-TTL code carries the same guarantee.
import type { ObjectId } from 'mongodb';
import { lanHandoffCodesCollection } from '../db/client.ts';
import {
  hashHandoffCode as hashCode,
  HANDOFF_CODE_TTL_MS as LAN_HANDOFF_CODE_TTL_MS,
  newHandoffCode,
} from './handoff-code.ts';

export interface IssuedLanHandoffCode {
  code: string;
}

/** Issue a single-use, short-TTL code bound to the user. The raw code is
 * returned once; only its hash is persisted. */
export async function issueLanHandoffCode(args: {
  userId: ObjectId;
  deviceLabel: string;
}): Promise<IssuedLanHandoffCode> {
  const code = newHandoffCode();
  const c = await lanHandoffCodesCollection();
  await c.insertOne({
    code_hash: hashCode(code),
    user_id: args.userId,
    device_label: args.deviceLabel,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + LAN_HANDOFF_CODE_TTL_MS),
    consumed_at: null,
  });
  return { code };
}

export interface RedeemedLanHandoffCode {
  userId: ObjectId;
  deviceLabel: string;
}

/** Atomically consume the code IFF it is unconsumed and unexpired — a single
 * CAS via `findOneAndUpdate`, no read-then-write TOCTOU. Returns null when
 * nothing matched (unknown, expired, or already-consumed code). */
export async function redeemLanHandoffCode(
  rawCode: string,
): Promise<RedeemedLanHandoffCode | null> {
  const c = await lanHandoffCodesCollection();
  const row = await c.findOneAndUpdate(
    { code_hash: hashCode(rawCode), consumed_at: null, expires_at: { $gt: new Date() } },
    { $set: { consumed_at: new Date().toISOString() } },
  );
  if (!row) return null;
  return { userId: row.user_id, deviceLabel: row.device_label };
}
