/**
 * Paired-device sessions (Maple TV pairing, milestone B of the TV epic, #2075).
 *
 * A device session is a labeled, platform-marked refresh-token family.
 * Mint requires the caller's OWN live refresh token in the body — proof of a
 * persistent credential — so a leaked 15-minute access JWT can't escalate
 * into a 90-day device credential (same threat model as the step-up gate on
 * invites, adapted for native callers that can't run a WebAuthn ceremony
 * mid-pairing). Revoke is step-up-gated like invite-rescind: it's driven
 * from the web settings panel, which has the ceremony machinery.
 */
import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { refreshTokensCollection, usersCollection } from '../db/client.ts';
import { signAccessToken, hashRefreshToken } from '../auth/tokens.ts';
import {
  issueRefreshToken,
  listDeviceSessions,
  revokeDeviceSession,
} from '../auth/refresh_store.ts';
import { requireAuth, stepUpBeforeHandle } from '../auth/middleware.ts';
import { rateLimit, clientIp } from '../auth/rate_limit.ts';

function jwtSecret(): string {
  const s = process.env.MAPLE_JWT_SECRET;
  if (!s || s.length < 16) throw new Error('MAPLE_JWT_SECRET unset or too short');
  return s;
}

export const authDeviceSessionRoutes = new Elysia({ prefix: '/api/auth/device-sessions' })
  .use(requireAuth)
  .post(
    '/',
    async ({ body, auth, set, request }) => {
      const ip = clientIp(request);
      if (!rateLimit(`auth:${ip}`, 10, 60_000)) {
        set.status = 429;
        return { error: 'rate limited' };
      }
      const userId = new ObjectId(auth.user.sub);
      // Persistent-credential proof: the presented refresh token must be a
      // live (unrevoked, unexpired) token belonging to the caller. Read-only
      // — no rotation. It must also be a PRIMARY login's token (no platform
      // marker): a paired device's own credential cannot mint further device
      // sessions, so pairing authority stays with fully-authenticated primary
      // clients (jules review, PR #2076).
      const c = await refreshTokensCollection();
      // family_revoked_at guards the logout-race artifact: a grace-window
      // re-mint can insert a live-looking row (revoked_at null, no per-row
      // family marker) into a family that logout just killed — the proof must
      // require the whole family to be alive, not just the presented row.
      const proof = await c.findOne({
        token_hash: hashRefreshToken(body.refresh_token),
        user_id: userId,
        revoked_at: null,
        family_revoked_at: { $exists: false },
        expires_at: { $gt: new Date() },
        platform: { $exists: false },
      });
      if (!proof) {
        set.status = 403;
        return { error: 'refresh-token proof invalid' };
      }
      const user = await (await usersCollection()).findOne({ _id: userId });
      if (!user) {
        set.status = 401;
        return { error: 'user gone' };
      }
      const minted = await issueRefreshToken(userId, body.label, { platform: body.platform });
      const access_token = await signAccessToken(
        { sub: userId.toHexString(), email: user.email, role: user.role },
        jwtSecret(),
      );
      return { id: minted.familyId.toHexString(), access_token, refresh_token: minted.raw };
    },
    {
      body: t.Object({
        label: t.String({ minLength: 1, maxLength: 64 }),
        platform: t.Union([t.Literal('tvos')]),
        refresh_token: t.String({ minLength: 1 }),
      }),
    },
  )
  .get('/', async ({ auth }) => ({
    sessions: await listDeviceSessions(new ObjectId(auth.user.sub)),
  }))
  .delete(
    '/:id',
    async ({ params, auth, set }) => {
      const familyId = ObjectId.isValid(params.id) ? new ObjectId(params.id) : null;
      const revoked = familyId
        ? await revokeDeviceSession(new ObjectId(auth.user.sub), familyId)
        : false;
      if (!revoked) {
        set.status = 404;
        return { error: 'no such device session' };
      }
      return new Response(null, { status: 204 });
    },
    // Revoking persistent access is sensitive — same fresh-WebAuthn step-up
    // bar as invite create/rescind (#861).
    { beforeHandle: stepUpBeforeHandle },
  );
