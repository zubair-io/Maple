/**
 * The crypto behind the two one-time handoff codes, with no store in it.
 *
 * `native_code_store.ts` and `lan_handoff_store.ts` each carried their own copy
 * of the same four things — a UTF-8 encoder, a base64url encoder, a SHA-256
 * hex digest and a 32-byte random code — and the SQLite port (#3751) would
 * have made that a third and fourth. They belong together in one place, not
 * because the duplication was expensive, but because a code that is hashed one
 * way at issue and another way at redeem simply stops working, and one
 * definition cannot drift from itself.
 *
 * A raw code is never persisted. Both tables store {@link hashHandoffCode}'s
 * output, so a database read cannot mint a session.
 */

import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

/**
 * How long a handoff code lives. Short by design: the native app redeems
 * immediately after the `ASWebAuthenticationSession` redirect, and the LAN
 * handoff redeems as soon as the browser lands on the other origin.
 */
export const HANDOFF_CODE_TTL_MS = 60_000;

/**
 * PKCE S256 transform: `base64url(sha256(verifier))`.
 *
 * The native app sends this challenge when it launches the web flow and keeps
 * the verifier private, proving possession at redeem. The LAN handoff has no
 * equivalent on purpose — both of its ends are the same browser tab, so a
 * verifier would ride in the same URL as the code and prove nothing.
 */
export function pkceS256(codeVerifier: string): string {
  return b64url(sha256(utf8(codeVerifier)));
}

/** The stored form of a code: SHA-256, hex. */
export function hashHandoffCode(rawCode: string): string {
  return Buffer.from(sha256(utf8(rawCode))).toString('hex');
}

/** A fresh code, returned to its issuer once and never stored. */
export function newHandoffCode(): string {
  return b64url(randomBytes(32));
}
