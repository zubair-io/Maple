import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'node:crypto';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days (#860 shortens this)
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
  payload: { sub: string; email: string; role: 'owner' | 'member' },
  secret: string,
  opts: { expiresInSeconds?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (opts.expiresInSeconds ?? ACCESS_TTL_SECONDS);
  return new SignJWT({ email: payload.email, role: payload.role })
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
    if (e instanceof joseErrors.JWTExpired) throw new Error('token expired');
    if (e instanceof joseErrors.JWSSignatureVerificationFailed) throw new Error('bad signature');
    throw new Error('malformed token');
  }
  const { sub, email, role, iat, exp } = claims;
  if (
    typeof sub !== 'string' ||
    typeof email !== 'string' ||
    (role !== 'owner' && role !== 'member')
  ) {
    throw new Error('malformed claims');
  }
  if (typeof exp !== 'number') throw new Error('malformed claims');
  return { sub, email, role, iat: typeof iat === 'number' ? iat : 0, exp };
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
