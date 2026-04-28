/**
 * WebAuthn / passkey auth routes.
 *
 * Phase A: bootstrap probe + registration (claim path / invited member path).
 * Tasks A8/A9/A10 will append login/refresh/logout, credential management,
 * and invite endpoints to this same chain.
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import {
  usersCollection,
  credentialsCollection,
  invitesCollection,
} from "../db/client.ts";
import {
  buildRegistrationOptions,
  verifyRegistration,
  consumeChallenge,
  buildAuthenticationOptions,
  verifyAuthentication,
} from "../auth/webauthn.ts";
import {
  redeemInvite,
  createInvite,
  listInvites,
  rescindInvite,
} from "../auth/invites.ts";
import { signAccessToken, REFRESH_TTL_SECONDS } from "../auth/tokens.ts";
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeOne,
} from "../auth/refresh_store.ts";
import { requireAuth, requireOwner } from "../auth/middleware.ts";
import { rateLimit } from "../auth/rate_limit.ts";

function jwtSecret(): string {
  const s = process.env.MAPLE_JWT_SECRET;
  if (!s || s.length < 16) throw new Error("MAPLE_JWT_SECRET unset or too short");
  return s;
}

async function isClaimed(): Promise<boolean> {
  const u = await usersCollection();
  return (await u.countDocuments({}, { limit: 1 })) > 0;
}

export const authRoutes = new Elysia({ prefix: "/api/auth" })
  // ----- bootstrap -----
  .get("/bootstrap", async () => ({ claimed: await isClaimed() }))

  // ----- register/options -----
  .post(
    "/register/options",
    async ({ body, set, request }) => {
      const ip = (request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? "anon")
        .split(",")[0].trim();
      if (!rateLimit(`auth:${ip}`, 10, 60_000)) {
        set.status = 429; return { error: "rate limited" };
      }
      const email = body.email.toLowerCase();
      const claimed = await isClaimed();
      if (claimed) {
        if (!body.invite_code) {
          set.status = 403;
          return { error: "invite required" };
        }
        // Peek at invite without consuming (consumed on verify).
        const inv = await (await invitesCollection()).findOne({ code: body.invite_code });
        if (!inv || inv.consumed_at || inv.expires_at.getTime() < Date.now()) {
          set.status = 410;
          return { error: "invite invalid" };
        }
        if (inv.email !== email) {
          set.status = 410;
          return { error: "invite/email mismatch" };
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
        email: t.String({ format: "email" }),
        invite_code: t.Optional(t.String()),
      }),
    }
  )

  // ----- register/verify -----
  .post(
    "/register/verify",
    async ({ body, set, cookie }) => {
      const email = body.email.toLowerCase();
      const clientChallenge = body.credential?.response?.clientDataJSON
        ? JSON.parse(
            Buffer.from(body.credential.response.clientDataJSON, "base64url").toString()
          ).challenge
        : "";
      const challengeRow = await consumeChallenge(clientChallenge);
      if (challengeRow.purpose !== "register" || challengeRow.email !== email) {
        set.status = 400;
        return { error: "challenge mismatch" };
      }
      const verification = await verifyRegistration({
        response: body.credential,
        expectedChallenge: challengeRow.challenge,
      });
      if (!verification.verified || !verification.registrationInfo) {
        set.status = 400;
        return { error: "verification failed" };
      }

      const claimed = await isClaimed();
      if (claimed) {
        if (!challengeRow.invite_code) {
          set.status = 403;
          return { error: "invite required" };
        }
        await redeemInvite(challengeRow.invite_code, email);
      }

      const role: "owner" | "member" = claimed ? "member" : "owner";
      const u = await usersCollection();
      const userIns = await u.insertOne({
        email,
        role,
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      });

      const reg = verification.registrationInfo;
      const c = await credentialsCollection();
      await c.insertOne({
        user_id: userIns.insertedId,
        credential_id: reg.credential.id,
        public_key: Buffer.from(reg.credential.publicKey),
        counter: reg.credential.counter,
        transports: (body.credential.response?.transports ?? []) as string[],
        device_label: body.device_label,
        created_at: new Date().toISOString(),
        last_used_at: new Date().toISOString(),
      });

      const access_token = signAccessToken(
        { sub: userIns.insertedId.toHexString(), email, role },
        jwtSecret()
      );
      const refresh = await issueRefreshToken(userIns.insertedId, body.device_label);
      cookie.maple_refresh.set({
        value: refresh.raw,
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: REFRESH_TTL_SECONDS,
      });
      return {
        access_token,
        refresh_token: refresh.raw,
        user: { id: userIns.insertedId.toHexString(), email, role },
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        invite_code: t.Optional(t.String()),
        device_label: t.String({ minLength: 1, maxLength: 64 }),
        credential: t.Any(),
      }),
    }
  )

  // ----- login/options -----
  .post(
    "/login/options",
    async ({ body, set, request }) => {
      const ip = (request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? "anon")
        .split(",")[0].trim();
      if (!rateLimit(`auth:${ip}`, 10, 60_000)) {
        set.status = 429; return { error: "rate limited" };
      }
      const email = body.email.toLowerCase();
      const u = await (await usersCollection()).findOne({ email });
      if (!u) {
        set.status = 404;
        return { error: "no such user" };
      }
      return buildAuthenticationOptions(u._id, email);
    },
    { body: t.Object({ email: t.String({ format: "email" }) }) }
  )

  // ----- login/verify -----
  .post(
    "/login/verify",
    async ({ body, set, cookie }) => {
      const email = body.email.toLowerCase();
      const clientChallenge = body.credential?.response?.clientDataJSON
        ? JSON.parse(
            Buffer.from(body.credential.response.clientDataJSON, "base64url").toString()
          ).challenge
        : "";
      let challengeRow;
      try {
        challengeRow = await consumeChallenge(clientChallenge);
      } catch {
        set.status = 400;
        return { error: "challenge invalid" };
      }
      if (challengeRow.purpose !== "authenticate" || challengeRow.email !== email) {
        set.status = 400;
        return { error: "challenge mismatch" };
      }
      const user = await (await usersCollection()).findOne({ email });
      if (!user) {
        set.status = 404;
        return { error: "no such user" };
      }
      const cred = await (await credentialsCollection()).findOne({
        user_id: user._id,
        credential_id: body.credential.id,
      });
      if (!cred) {
        set.status = 400;
        return { error: "unknown credential" };
      }
      const verification = await verifyAuthentication({
        response: body.credential,
        expectedChallenge: challengeRow.challenge,
        credential: cred,
      });
      if (!verification.verified) {
        set.status = 400;
        return { error: "verification failed" };
      }

      await (await credentialsCollection()).updateOne(
        { _id: cred._id },
        {
          $set: {
            counter: verification.authenticationInfo.newCounter,
            last_used_at: new Date().toISOString(),
          },
        }
      );
      await (await usersCollection()).updateOne(
        { _id: user._id },
        { $set: { last_seen_at: new Date().toISOString() } }
      );

      const access_token = signAccessToken(
        { sub: user._id.toHexString(), email: user.email, role: user.role },
        jwtSecret()
      );
      const refresh = await issueRefreshToken(user._id, cred.device_label);
      cookie.maple_refresh.set({
        value: refresh.raw,
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: REFRESH_TTL_SECONDS,
      });
      return {
        access_token,
        refresh_token: refresh.raw,
        user: { id: user._id.toHexString(), email: user.email, role: user.role },
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        credential: t.Any(),
      }),
    }
  )

  // ----- refresh -----
  .post(
    "/refresh",
    async ({ body, cookie, set, request }) => {
      const ip = (request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? "anon")
        .split(",")[0].trim();
      if (!rateLimit(`auth:${ip}`, 10, 60_000)) {
        set.status = 429; return { error: "rate limited" };
      }
      const cookieRaw = cookie.maple_refresh?.value as string | undefined;
      const raw: string | undefined = body.refresh_token ?? cookieRaw;
      if (!raw) {
        set.status = 401;
        return { error: "no refresh token" };
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
        return { error: "user gone" };
      }
      const access_token = signAccessToken(
        { sub: user._id.toHexString(), email: user.email, role: user.role },
        jwtSecret()
      );
      // Re-set the cookie if the request used cookie auth.
      if (cookieRaw) {
        cookie.maple_refresh.set({
          value: fresh.raw,
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge: REFRESH_TTL_SECONDS,
        });
      }
      return { access_token, refresh_token: fresh.raw };
    },
    { body: t.Object({ refresh_token: t.Optional(t.String()) }) }
  )

  // ----- logout -----
  .post(
    "/logout",
    async ({ body, cookie }) => {
      const cookieRaw = cookie.maple_refresh?.value as string | undefined;
      const raw: string | undefined = body.refresh_token ?? cookieRaw;
      if (raw) {
        try {
          await revokeOne(raw);
        } catch {
          /* swallow */
        }
      }
      cookie.maple_refresh?.remove();
      return new Response(null, { status: 204 });
    },
    { body: t.Object({ refresh_token: t.Optional(t.String()) }) }
  )

  // ----- invites (owner-only) -----
  .group("/invites", (g) =>
    g.use(requireAuth).use(requireOwner)
      .post(
        "/",
        async ({ body, auth }) => {
          const inv = await createInvite(new ObjectId(auth.user.sub), body.email);
          return { code: inv.code, expires_at: inv.expires_at };
        },
        { body: t.Object({ email: t.String({ format: "email" }) }) }
      )
      .get("/", async () => listInvites())
      .delete("/:code", async ({ params }) => {
        await rescindInvite(params.code);
        return new Response(null, { status: 204 });
      })
  )

  // ----- /me + credential management (user-scoped) -----
  // Mount routes via a sub-Elysia so requireAuth's scoped derive only
  // applies here. Note: `.group("/", g => g.use(requireAuth)...)` does not
  // resolve in this Elysia version — see Task A10 implementation notes.
  .use(requireAuth)
  .get("/me", async ({ auth }) => {
    const userId = new ObjectId(auth.user.sub);
    const user = await (await usersCollection()).findOne({ _id: userId });
    const creds = await (await credentialsCollection())
      .find(
        { user_id: userId },
        { projection: { _id: 1, device_label: 1, last_used_at: 1, created_at: 1 } }
      )
      .toArray();
    return {
      user: user
        ? { id: user._id.toHexString(), email: user.email, role: user.role }
        : null,
      credentials: creds.map((c) => ({
        id: c._id.toHexString(),
        device_label: c.device_label,
        last_used_at: c.last_used_at,
        created_at: c.created_at,
      })),
    };
  })

  // ----- add another credential -----
  .post("/credentials/options", async ({ auth }) => {
    const userId = new ObjectId(auth.user.sub);
    const existing = await (await credentialsCollection())
      .find({ user_id: userId }, { projection: { credential_id: 1 } })
      .toArray();
    return buildRegistrationOptions({
      email: auth.user.email,
      inviteCode: null,
      existingUserId: userId,
      excludeCredentialIds: existing.map((e) => e.credential_id),
    });
  })

  .post(
    "/credentials/verify",
    async ({ auth, body, set }) => {
      const userId = new ObjectId(auth.user.sub);
      const clientChallenge = body.credential?.response?.clientDataJSON
        ? JSON.parse(
            Buffer.from(body.credential.response.clientDataJSON, "base64url").toString()
          ).challenge
        : "";
      const challengeRow = await consumeChallenge(clientChallenge);
      if (
        challengeRow.purpose !== "add_credential" ||
        !challengeRow.user_id ||
        !challengeRow.user_id.equals(userId)
      ) {
        set.status = 400;
        return { error: "challenge mismatch" };
      }
      const verification = await verifyRegistration({
        response: body.credential,
        expectedChallenge: challengeRow.challenge,
      });
      if (!verification.verified || !verification.registrationInfo) {
        set.status = 400;
        return { error: "verification failed" };
      }
      const reg = verification.registrationInfo;
      const c = await credentialsCollection();
      const ins = await c.insertOne({
        user_id: userId,
        credential_id: reg.credential.id,
        public_key: Buffer.from(reg.credential.publicKey),
        counter: reg.credential.counter,
        transports: (body.credential.response?.transports ?? []) as string[],
        device_label: body.device_label,
        created_at: new Date().toISOString(),
        last_used_at: new Date().toISOString(),
      });
      return { credential_id: ins.insertedId.toHexString() };
    },
    {
      body: t.Object({
        credential: t.Any(),
        device_label: t.String({ minLength: 1, maxLength: 64 }),
      }),
    }
  )

  .delete("/credentials/:id", async ({ auth, params, set }) => {
    const userId = new ObjectId(auth.user.sub);
    const c = await credentialsCollection();
    const count = await c.countDocuments({ user_id: userId });
    if (count <= 1) {
      set.status = 409;
      return { error: "cannot remove last credential" };
    }
    const r = await c.deleteOne({ _id: new ObjectId(params.id), user_id: userId });
    if (r.deletedCount === 0) {
      set.status = 404;
      return { error: "not found" };
    }
    return new Response(null, { status: 204 });
  });
