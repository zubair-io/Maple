// src/api/src/auth/middleware.ts
import { Elysia } from 'elysia';
import { verifyAccessToken, verifyStepUpToken, type AccessClaims } from './tokens.ts';

function jwtSecret(): string {
  const s = process.env.MAPLE_JWT_SECRET;
  if (!s || s.length < 16) throw new Error('MAPLE_JWT_SECRET unset or too short');
  return s;
}

export const requireAuth = new Elysia({ name: 'requireAuth' }).derive(
  { as: 'scoped' },
  async ({ headers, set }) => {
    const h = headers['authorization'] ?? '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) {
      set.status = 401;
      throw new Error('missing bearer');
    }
    let claims: AccessClaims;
    try {
      claims = await verifyAccessToken(m[1], jwtSecret());
    } catch (e) {
      set.status = 401;
      throw e;
    }
    // Stateless: signature + exp only, NO per-request DB read. Revocation is
    // bounded by the short (15-min) access TTL — once a refresh family is
    // revoked (logout / reuse / sign-out-everywhere), the in-flight access token
    // simply ages out and can't be renewed. This is the deliberate trade for a
    // photo-backup/thumbnail workload that hammers `/api/*`: no auth DB lookup
    // on the hot path.
    return { auth: { user: claims } };
  },
);

export const requireOwner = new Elysia({ name: 'requireOwner' })
  .use(requireAuth)
  .onBeforeHandle({ as: 'scoped' }, ({ auth, set }) => {
    if (!auth || auth.user.role !== 'owner') {
      set.status = 403;
      return { error: 'owner role required' };
    }
  });

interface StepUpContext {
  auth?: { user: AccessClaims };
  headers: Record<string, string | undefined>;
  set: { status?: number | string };
}

/**
 * Route `beforeHandle` that requires a fresh step-up token (#861) in the
 * `X-Step-Up` header, minted by `/api/auth/step-up/verify` after a fresh
 * WebAuthn assertion and matching the authenticated user. A valid access token
 * alone is NOT enough for sensitive actions (add/remove credential, create/
 * rescind invite) — so a leaked short-lived access token can't escalate into
 * persistent access. Mount only on `requireAuth`-gated routes (it reads `auth`).
 */
export async function stepUpBeforeHandle({ auth, headers, set }: StepUpContext) {
  const token = headers['x-step-up'];
  if (!token) {
    set.status = 403;
    return { error: 'step-up required' };
  }
  let claims: { sub: string };
  try {
    claims = await verifyStepUpToken(token, jwtSecret());
  } catch {
    set.status = 403;
    return { error: 'step-up invalid' };
  }
  if (!auth || claims.sub !== auth.user.sub) {
    set.status = 403;
    return { error: 'step-up subject mismatch' };
  }
}
