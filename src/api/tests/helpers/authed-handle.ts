/**
 * Test helper: drive the real assembled `app` with a valid bearer attached.
 *
 * The PhotoKit-backup routes are gated behind `requireAuth` (#853). These
 * integration tests exercise handler behaviour, not auth, so we auto-attach an
 * owner access token unless the request already carries an `Authorization`
 * header. The token is signed, not DB-backed — `requireAuth` verifies the JWT
 * signature + expiry without a user lookup, so no fixture user is required.
 *
 * The bearer is generated lazily at call-time (not at module-load time) so that
 * tests which set `MAPLE_JWT_SECRET` after import still get the correct token.
 */
import { app } from '../../src/index.ts';
import { signAccessToken } from '../../src/auth/tokens.ts';

async function makeBearer(): Promise<string> {
  const secret = process.env.MAPLE_JWT_SECRET ?? 'x'.repeat(32);
  process.env.MAPLE_JWT_SECRET = secret;
  return `Bearer ${await signAccessToken(
    { sub: '0'.repeat(24), email: 'test@maple.local', role: 'owner', file_access: true },
    secret,
  )}`;
}

/** Like `app.handle(req)`, but injects a valid bearer when none is present. */
export async function authedHandle(req: Request): Promise<Response> {
  if (!req.headers.has('authorization')) {
    req.headers.set('authorization', await makeBearer());
  }
  return app.handle(req);
}
