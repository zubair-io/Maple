/**
 * JWT verification for the Worker — mirrors `src/api/src/auth/tokens.ts`'s
 * `verifyAccessToken`. `jose` runs on Web Crypto so it works unmodified in
 * the Workers runtime; verification is constrained to HS256 (the API's
 * single pinned signing algorithm), so an `alg: none` or RS/HS-confusion
 * forgery is rejected before the signature is even checked.
 *
 * The Worker only needs to know a request is authenticated as SOME valid
 * user — it doesn't branch on role or read `email`/`sub` — so this checks
 * signature + expiry and returns nothing more than a boolean.
 */

import { jwtVerify, errors as joseErrors } from 'jose';

const ALG = 'HS256';

function secretKey(secret: string): Uint8Array {
	return new TextEncoder().encode(secret);
}

/** Verify the bearer token from an `Authorization` header value against the
 * shared JWT secret. Returns `true` for a validly-signed, unexpired token;
 * `false` for anything else (missing header, bad signature, expired,
 * malformed) — the caller doesn't need to distinguish the failure modes. */
export async function verifyBearer(
	authorizationHeader: string | null,
	secret: string,
): Promise<boolean> {
	const match = authorizationHeader ? /^Bearer (.+)$/.exec(authorizationHeader) : null;
	if (!match) return false;
	try {
		await jwtVerify(match[1], secretKey(secret), { algorithms: [ALG] });
		return true;
	} catch (e) {
		if (e instanceof joseErrors.JWTExpired) return false;
		if (e instanceof joseErrors.JWSSignatureVerificationFailed) return false;
		return false;
	}
}
