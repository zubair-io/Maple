// Native one-time auth-code store (#856).
//
// PKCE code-exchange for the Apple shell, replacing the legacy
// token-in-redirect-URL bridge. The web app (after a passkey ceremony
// establishes a session) issues a short-TTL, single-use code bound to a PKCE
// challenge + opaque state; the native app redeems it (with the verifier) for
// freshly-minted, device-scoped tokens. A raw refresh token therefore never
// rides in a redirect URL.
import type { ObjectId } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { nativeAuthCodesCollection } from '../db/client.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

/** One-time code TTL — short by design; the native app redeems immediately
 * after the ASWebAuthenticationSession redirect. */
const NATIVE_CODE_TTL_MS = 60_000;

/** PKCE S256 transform: `base64url(sha256(verifier))`. The native app sends
 * this challenge when it launches the web flow and keeps the verifier private,
 * proving possession at redeem. */
export function pkceS256(codeVerifier: string): string {
  return b64url(sha256(utf8(codeVerifier)));
}

function hashCode(rawCode: string): string {
  return Buffer.from(sha256(utf8(rawCode))).toString('hex');
}

export interface IssuedNativeCode {
  code: string;
}

/** Issue a single-use, short-TTL authorization code bound to the user, the
 * PKCE challenge, and an opaque `state`. The raw code is returned once; only
 * its hash is persisted. */
export async function issueNativeCode(args: {
  userId: ObjectId;
  codeChallenge: string;
  state: string;
  deviceLabel: string;
}): Promise<IssuedNativeCode> {
  const code = b64url(randomBytes(32));
  const c = await nativeAuthCodesCollection();
  await c.insertOne({
    code_hash: hashCode(code),
    code_challenge: args.codeChallenge,
    state: args.state,
    user_id: args.userId,
    device_label: args.deviceLabel,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + NATIVE_CODE_TTL_MS),
    consumed_at: null,
  });
  return { code };
}

export interface RedeemedNativeCode {
  userId: ObjectId;
  deviceLabel: string;
  state: string;
}

/** Atomically consume the code IFF it is unconsumed, unexpired, and the
 * supplied verifier hashes to the stored PKCE challenge. The challenge match is
 * part of the `findOneAndUpdate` filter (a single CAS — no read-then-write
 * TOCTOU), so a wrong verifier neither succeeds nor burns the code. Returns
 * null when nothing matched. */
export async function redeemNativeCode(
  rawCode: string,
  codeVerifier: string,
): Promise<RedeemedNativeCode | null> {
  const c = await nativeAuthCodesCollection();
  const row = await c.findOneAndUpdate(
    {
      code_hash: hashCode(rawCode),
      code_challenge: pkceS256(codeVerifier),
      consumed_at: null,
      expires_at: { $gt: new Date() },
    },
    { $set: { consumed_at: new Date().toISOString() } },
  );
  if (!row) return null;
  return { userId: row.user_id, deviceLabel: row.device_label, state: row.state };
}
