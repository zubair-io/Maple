/**
 * JWT verification for the Worker — mirrors `src/api/src/auth/tokens.ts`'s
 * `verifyAccessToken`. `jose` runs on Web Crypto so it works unmodified in
 * the Workers runtime; verification is constrained to HS256 (the API's
 * single pinned signing algorithm), so an `alg: none` or RS/HS-confusion
 * forgery is rejected before the signature is even checked.
 *
 * The Worker only needs to know a request is authenticated as SOME valid
 * user, so this checks signature + expiry + an access-token `role` claim and
 * returns a boolean. The role requirement rejects step-up assertions
 * (`purpose: 'step_up'`, no role), which share the signing secret but are not
 * access tokens.
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
		const { payload } = await jwtVerify(match[1], secretKey(secret), { algorithms: [ALG] });
		return payload.role === 'owner' || payload.role === 'member';
	} catch (e) {
		if (e instanceof joseErrors.JWTExpired) return false;
		if (e instanceof joseErrors.JWSSignatureVerificationFailed) return false;
		return false;
	}
}
