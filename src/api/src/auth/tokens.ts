import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'node:crypto';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const ACCESS_TTL_SECONDS = 15 * 60; // 15 minutes (#860 — short-lived; rotation absorbs the cadence)
export const REFRESH_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

/**
 * The single pinned signing algorithm. Verification is constrained to this one
 * value, so `alg`-confusion (e.g. a forged `alg: none` or an RS/HS swap) is
 * impossible by construction — jose rejects any token whose header `alg` is not
 * in the allowlist before it ever looks at the signature.
 */
const ALG = 'HS256';

export interface AccessClaims {
  sub: string; // user_id
  email: string;
  role: 'owner' | 'member';
  /**
   * Per-user "file access" permission (#2893): may this user browse the
   * filesystem and move/rename/trash files? Rides in the token (same
   * stateless trade as `role` — revocation lands within the 15-min TTL).
   * Owners always have it.
   */
  file_access: boolean;
  iat: number;
  exp: number;
}

function secretKey(secret: string): Uint8Array {
  return utf8(secret);
}

/**
 * Sign a short-lived access JWT (HS256) via `jose`. Async because `jose`'s
 * Web-Crypto-backed signing has no synchronous API.
 */
export async function signAccessToken(
  payload: { sub: string; email: string; role: 'owner' | 'member'; file_access: boolean },
  secret: string,
  opts: { expiresInSeconds?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (opts.expiresInSeconds ?? ACCESS_TTL_SECONDS);
  return new SignJWT({ email: payload.email, role: payload.role, file_access: payload.file_access })
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setSubject(payload.sub)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secretKey(secret));
}

/**
 * Verify + decode an access JWT. Throws on a bad/expired/malformed token.
 *
 * jose's native error messages differ from the hand-rolled implementation this
 * replaced; we map them back to the original strings (`bad signature`,
 * `token expired`, `malformed …`) so the middleware contract and every existing
 * test assertion stay byte-stable.
 */
export async function verifyAccessToken(jwt: string, secret: string): Promise<AccessClaims> {
  let claims: Record<string, unknown>;
  try {
    const { payload } = await jwtVerify(jwt, secretKey(secret), { algorithms: [ALG] });
    claims = payload as Record<string, unknown>;
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) throw new Error('token expired', { cause: e });
    if (e instanceof joseErrors.JWSSignatureVerificationFailed)
      throw new Error('bad signature', { cause: e });
    throw new Error('malformed token', { cause: e });
  }
  const { sub, email, role, file_access, iat, exp } = claims;
  if (
    typeof sub !== 'string' ||
    typeof email !== 'string' ||
    (role !== 'owner' && role !== 'member')
  ) {
    throw new Error('malformed claims');
  }
  if (typeof exp !== 'number') throw new Error('malformed claims');
  return {
    sub,
    email,
    role,
    // Tokens minted before #2893 carry no file_access claim; every user had
    // full access then, so absent = true. Owners are always true regardless
    // (the mint side enforces it; this is belt-and-braces for old tokens).
    file_access: role === 'owner' ? true : file_access !== false,
    iat: typeof iat === 'number' ? iat : 0,
    exp,
  };
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(raw: string): string {
  return Buffer.from(sha256(utf8(raw))).toString('hex');
}

export function refreshExpiresAt(): Date {
  return new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
}

/** Step-up token lifetime (#861) — a fresh WebAuthn assertion is good for this
 * long before a sensitive action needs another one. */
export const STEP_UP_TTL_SECONDS = 5 * 60; // 5 minutes

/**
 * Sign a short-lived step-up token (#861), minted only after a fresh WebAuthn
 * assertion. It is NOT an access token (no role) — it just attests "this user
 * re-proved a passkey within the last few minutes" and gates sensitive actions.
 */
export async function signStepUpToken(sub: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ purpose: 'step_up' })
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + STEP_UP_TTL_SECONDS)
    .sign(secretKey(secret));
}

/** Verify a step-up token; returns its subject. Throws on bad/expired/wrong-purpose. */
export async function verifyStepUpToken(token: string, secret: string): Promise<{ sub: string }> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, secretKey(secret), { algorithms: [ALG] }));
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) throw new Error('step-up expired', { cause: e });
    throw new Error('step-up invalid', { cause: e });
  }
  if (payload.purpose !== 'step_up' || typeof payload.sub !== 'string') {
    throw new Error('step-up invalid');
  }
  return { sub: payload.sub };
}
