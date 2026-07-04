/**
 * WebAuthn / passkey auth routes.
 *
 * Phase A: bootstrap probe + registration (claim path / invited member path).
 * Tasks A8/A9/A10 will append login/refresh/logout, credential management,
 * and invite endpoints to this same chain.
 */

import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { usersCollection, credentialsCollection, invitesCollection } from '../db/client.ts';
import {
  buildRegistrationOptions,
  verifyRegistration,
  consumeChallenge,
  buildDiscoverableAuthenticationOptions,
  verifyAuthentication,
} from '../auth/webauthn.ts';
import { redeemInvite, createInvite, listInvites, rescindInvite } from '../auth/invites.ts';
import { signAccessToken, REFRESH_TTL_SECONDS } from '../auth/tokens.ts';
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeFamilyByToken,
} from '../auth/refresh_store.ts';
import { requireAuth, requireOwner, stepUpBeforeHandle } from '../auth/middleware.ts';
import { rateLimit, clientIp } from '../auth/rate_limit.ts';
import { tryClaimOwnership, releaseOwnershipClaim } from '../auth/server_claim.ts';

function jwtSecret(): string {
  const s = process.env.MAPLE_JWT_SECRET;
  if (!s || s.length < 16) throw new Error('MAPLE_JWT_SECRET unset or too short');
  return s;
}

async function isClaimed(): Promise<boolean> {
  const u = await usersCollection();
  return (await u.countDocuments({}, { limit: 1 })) > 0;
}

function devAuthEnabled(): boolean {
  return process.env.MAPLE_DEV_AUTH === '1';
}

export const authRoutes = new Elysia({ prefix: '/api/auth' })
  // ----- bootstrap -----
  .get('/bootstrap', async () => ({
    claimed: await isClaimed(),
    dev_login_enabled: devAuthEnabled(),
  }))

  // ----- dev-login (gated on MAPLE_DEV_AUTH=1) -----
  // Bypasses the WebAuthn ceremony for local development. When the env flag
  // is unset, the route returns 404 so it's invisible in production builds.
  // When set, mints the same access + refresh token pair as /login/verify
  // for an upserted dev user (default email "dev@maple.local", owner role).
  .post(
    '/dev-login',
    async ({ body, set, cookie }) => {
      if (!devAuthEnabled()) {
        set.status = 404;
        return { error: 'not found' };
      }
      const email = (body.email ?? 'dev@maple.local').toLowerCase();
      const u = await usersCollection();
      let user = await u.findOne({ email });
      if (!user) {
        const ins = await u.insertOne({
          email,
          role: 'owner',
          created_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        });
        user = await u.findOne({ _id: ins.insertedId });
        if (!user) {
          set.status = 500;
          return { error: 'failed to create dev user' };
        }
      } else {
        await u.updateOne({ _id: user._id }, { $set: { last_seen_at: new Date().toISOString() } });
      }
      const access_token = await signAccessToken(
        {
          sub: user._id.toHexString(),
          email: user.email,
          role: user.role,
        },
        jwtSecret(),
      );
      const refresh = await issueRefreshToken(user._id, 'dev-login');
      cookie.maple_refresh.set({
        value: refresh.raw,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: REFRESH_TTL_SECONDS,
      });
      return {
        access_token,
        user: {
          id: user._id.toHexString(),
          email: user.email,
          role: user.role,
        },
      };
    },
    { body: t.Object({ email: t.Optional(t.String({ format: 'email' })) }) },
  )

  // ----- register/options -----
  .post(
    '/register/options',
    async ({ body, set, request }) => {
      const ip = clientIp(request);
      if (!rateLimit(`auth:${ip}`, 10, 60_000)) {
        set.status = 429;
        return { error: 'rate limited' };
      }
      const email = body.email.toLowerCase();
      const claimed = await isClaimed();
      if (claimed) {
        if (!body.invite_code) {
          set.status = 403;
          return { error: 'invite required' };
        }
        // Peek at invite without consuming (consumed on verify).
        const inv = await (await invitesCollection()).findOne({ code: body.invite_code });
        if (!inv || inv.consumed_at || inv.expires_at.getTime() < Date.now()) {
          set.status = 410;
          return { error: 'invite invalid' };
        }
        if (inv.email !== email) {
          set.status = 410;
          return { error: 'invite/email mismatch' };
        }
      }
      return buildRegistrationOptions({
        email,
        inviteCode: body.invite_code ?? null,
        existingUserId: null,
        excludeCredentialIds: [],
      });
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
        invite_code: t.Optional(t.String()),
      }),
    },
  )

  // ----- register/verify -----
  .post(
    '/register/verify',
    async ({ body, set, cookie }) => {
      const email = body.email.toLowerCase();
      const clientChallenge = body.credential?.response?.clientDataJSON
        ? JSON.parse(Buffer.from(body.credential.response.clientDataJSON, 'base64url').toString())
            .challenge
        : '';
      const challengeRow = await consumeChallenge(clientChallenge);
      if (challengeRow.purpose !== 'register' || challengeRow.email !== email) {
        set.status = 400;
        return { error: 'challenge mismatch' };
      }
      const verification = await verifyRegistration({
        response: body.credential,
        expectedChallenge: challengeRow.challenge,
      });
      if (!verification.verified || !verification.registrationInfo) {
        set.status = 400;
        return { error: 'verification failed' };
      }

      // Atomically decide ownership (#865): exactly one concurrent first
      // registration wins the single owner slot. A lost claim means the server
      // is already claimed → this registration must be an invited member.
      const wonOwnership = await tryClaimOwnership();
      const role: 'owner' | 'member' = wonOwnership ? 'owner' : 'member';
      if (!wonOwnership && !challengeRow.invite_code) {
        set.status = 403;
        return { error: 'invite required' };
      }

      // All-or-nothing from here (#865): if anything fails, roll back the user
      // we inserted and (if we made it) the ownership claim, so we never strand
      // a credential-less owner or a "claimed" server with no owner account.
      const u = await usersCollection();
      const c = await credentialsCollection();
      let userId: ObjectId | null = null;
      try {
        if (!wonOwnership) {
          await redeemInvite(challengeRow.invite_code!, email);
        }
        const userIns = await u.insertOne({
          email,
          role,
          created_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        });
        userId = userIns.insertedId;

        const reg = verification.registrationInfo;
        await c.insertOne({
          user_id: userId,
          credential_id: reg.credential.id,
          public_key: Buffer.from(reg.credential.publicKey),
          counter: reg.credential.counter,
          transports: (body.credential.response?.transports ?? []) as string[],
          device_label: body.device_label,
          created_at: new Date().toISOString(),
          last_used_at: new Date().toISOString(),
        });

        const access_token = await signAccessToken(
          { sub: userId.toHexString(), email, role },
          jwtSecret(),
        );
        const refresh = await issueRefreshToken(userId, body.device_label);
        cookie.maple_refresh.set({
          value: refresh.raw,
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/',
          maxAge: REFRESH_TTL_SECONDS,
        });
        return {
          access_token,
          user: { id: userId.toHexString(), email, role },
        };
      } catch (e) {
        if (userId) await u.deleteOne({ _id: userId });
        if (wonOwnership) await releaseOwnershipClaim();
        throw e;
      }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
        invite_code: t.Optional(t.String()),
        device_label: t.String({ minLength: 1, maxLength: 64 }),
        credential: t.Any(),
      }),
    },
  )

  // ----- login/options -----
  .post(
    '/login/options',
    async ({ set, request }) => {
      const ip = clientIp(request);
      if (!rateLimit(`auth:${ip}`, 10, 60_000)) {
        set.status = 429;
        return { error: 'rate limited' };
      }
      // Pure passkey (#1377): login takes no email. Always issue discoverable
      // options (empty allowCredentials) — the authenticator offers the user's
      // resident passkey and login/verify identifies the account from the
      // asserted credential id. No user lookup, so no account-existence oracle.
      return buildDiscoverableAuthenticationOptions();
    },
    // No input — login is pure passkey. Elysia strips any stray keys (e.g. a
    // stale client still sending `email`), so this stays back-compatible.
    { body: t.Object({}) },
  )

  // ----- login/verify -----
  .post(
    '/login/verify',
    async ({ body, set, cookie }) => {
      const clientChallenge = body.credential?.response?.clientDataJSON
        ? JSON.parse(Buffer.from(body.credential.response.clientDataJSON, 'base64url').toString())
            .challenge
        : '';

      // Consume the challenge first so an invalid/replayed challenge can't
      // trigger DB lookups (amplification on bad input). Single-use.
      let challengeRow;
      try {
        challengeRow = await consumeChallenge(clientChallenge);
      } catch {
        set.status = 400;
        return { error: 'challenge invalid' };
      }
      if (challengeRow.purpose !== 'authenticate') {
        set.status = 400;
        return { error: 'challenge mismatch' };
      }

      // Identify the account from the asserted credential id (#1304) — works for
      // both usernameless and email-scoped sign-in. No email binding is needed:
      // the challenge is single-use and the assertion signature is verified
      // against THIS credential's stored public key.
      const credentialId = body.credential?.id;
      if (!credentialId) {
        set.status = 400;
        return { error: 'unknown credential' };
      }
      const [credsColl, usersColl] = await Promise.all([
        credentialsCollection(),
        usersCollection(),
      ]);
      const cred = await credsColl.findOne({ credential_id: credentialId });
      if (!cred) {
        set.status = 400;
        return { error: 'unknown credential' };
      }
      const user = await usersColl.findOne({ _id: cred.user_id });
      if (!user) {
        set.status = 404;
        return { error: 'no such user' };
      }

      const verification = await verifyAuthentication({
        response: body.credential,
        expectedChallenge: challengeRow.challenge,
        credential: cred,
      });
      if (!verification.verified) {
        set.status = 400;
        return { error: 'verification failed' };
      }

      // Kick off the two updates without awaiting so JWT signing (sync,
      // CPU-bound) overlaps with the DB round-trips. issueRefreshToken is
      // sequenced AFTER the updates so a failure on either update doesn't
      // leave an orphan refresh token row (the row would still TTL-expire
      // on the `expires_at` index, but better to never write it).
      const nowIso = new Date().toISOString();
      const updates = Promise.all([
        credsColl.updateOne(
          { _id: cred._id },
          {
            $set: {
              counter: verification.authenticationInfo.newCounter,
              last_used_at: nowIso,
            },
          },
        ),
        usersColl.updateOne({ _id: user._id }, { $set: { last_seen_at: nowIso } }),
      ]);
      const access_token = await signAccessToken(
        {
          sub: user._id.toHexString(),
          email: user.email,
          role: user.role,
        },
        jwtSecret(),
      );
      await updates;
      const refresh = await issueRefreshToken(user._id, cred.device_label);

      cookie.maple_refresh.set({
        value: refresh.raw,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: REFRESH_TTL_SECONDS,
      });
      return {
        access_token,
        user: {
          id: user._id.toHexString(),
          email: user.email,
          role: user.role,
        },
      };
    },
    {
      body: t.Object({
        // Pure passkey (#1377): no email — the account is identified by the
        // asserted credential id.
        credential: t.Any(),
      }),
    },
  )

  // ----- refresh -----
  .post(
    '/refresh',
    async ({ body, cookie, set, request }) => {
      const ip = clientIp(request);
      if (!rateLimit(`auth:${ip}`, 10, 60_000)) {
        set.status = 429;
        return { error: 'rate limited' };
      }
      const cookieRaw = cookie.maple_refresh?.value as string | undefined;
      const raw: string | undefined = body.refresh_token ?? cookieRaw;
      if (!raw) {
        set.status = 401;
        return { error: 'no refresh token' };
      }
      let fresh;
      try {
        fresh = await rotateRefreshToken(raw);
      } catch (err) {
        set.status = 401;
        return { error: (err as Error).message };
      }
      const user = await (await usersCollection()).findOne({ _id: fresh.userId });
      if (!user) {
        set.status = 401;
        return { error: 'user gone' };
      }
      const access_token = await signAccessToken(
        {
          sub: user._id.toHexString(),
          email: user.email,
          role: user.role,
        },
        jwtSecret(),
      );
      // Re-set the cookie if the request used cookie auth.
      if (cookieRaw) {
        cookie.maple_refresh.set({
          value: fresh.raw,
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/',
          maxAge: REFRESH_TTL_SECONDS,
        });
      }
      return { access_token };
    },
    { body: t.Object({ refresh_token: t.Optional(t.String()) }) },
  )

  // ----- logout -----
  .post(
    '/logout',
    async ({ body, cookie }) => {
      const cookieRaw = cookie.maple_refresh?.value as string | undefined;
      const raw: string | undefined = body.refresh_token ?? cookieRaw;
      if (raw) {
        try {
          // Sign the whole device family out, not just the one presented token
          // (#858) — otherwise a re-minted sibling from the grace window would
          // stay live and the logout wouldn't actually log out.
          await revokeFamilyByToken(raw);
        } catch {
          /* swallow */
        }
      }
      cookie.maple_refresh?.remove();
      return new Response(null, { status: 204 });
    },
    { body: t.Object({ refresh_token: t.Optional(t.String()) }) },
  )

  // ----- invites (owner-only) -----
  .group('/invites', (g) =>
    g
      .use(requireAuth)
      .use(requireOwner)
      .post(
        '/',
        async ({ body, auth }) => {
          const inv = await createInvite(new ObjectId(auth.user.sub), body.email);
          return { code: inv.code, expires_at: inv.expires_at };
        },
        // #861: creating an invite is sensitive — require a fresh step-up.
        {
          body: t.Object({ email: t.String({ format: 'email' }) }),
          beforeHandle: stepUpBeforeHandle,
        },
      )
      .get('/', async () => listInvites())
      .delete(
        '/:code',
        async ({ params }) => {
          await rescindInvite(params.code);
          return new Response(null, { status: 204 });
        },
        // #861: rescinding an invite is sensitive — require a fresh step-up.
        { beforeHandle: stepUpBeforeHandle },
      ),
  )

  // GET /api/auth/jwt-secret — deliberate, narrowly-scoped exception to
  // "secrets are never echoed": the operator needs the raw value to run
  // `wrangler secret put JWT_SECRET` so the Cloudflare thumbnail-cache
  // Worker (src/cloudflare/, sub-issue 3 of #1757) can independently
  // verify the same access tokens the API issues. Owner-gated;
  // `Cache-Control: no-store` so it never lands in a shared/browser cache.
  .group('/jwt-secret', (g) =>
    g
      .use(requireAuth)
      .use(requireOwner)
      .get('/', ({ set }) => {
        set.headers['cache-control'] = 'no-store';
        return { secret: jwtSecret() };
      }),
  );
