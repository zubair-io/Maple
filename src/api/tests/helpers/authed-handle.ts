/**
 * Test helper: drive the real assembled `app` with a valid bearer attached.
 *
 * The PhotoKit-backup routes are gated behind `requireAuth` (#853). These
 * integration tests exercise handler behaviour, not auth, so we auto-attach an
 * owner access token unless the request already carries an `Authorization`
 * header. The token is signed, not DB-backed — `requireAuth` verifies the JWT
 * signature + expiry without a user lookup, so no fixture user is required.
 */
import { app } from '../../src/index.ts';
import { signAccessToken } from '../../src/auth/tokens.ts';

const SECRET = process.env.MAPLE_JWT_SECRET ?? 'x'.repeat(32);
process.env.MAPLE_JWT_SECRET = SECRET;

const BEARER = `Bearer ${await signAccessToken(
  { sub: '0'.repeat(24), email: 'test@maple.local', role: 'owner' },
  SECRET,
)}`;

/** Like `app.handle(req)`, but injects a valid bearer when none is present. */
export function authedHandle(req: Request): Promise<Response> {
  if (!req.headers.has('authorization')) {
    req.headers.set('authorization', BEARER);
  }
  return app.handle(req);
}
