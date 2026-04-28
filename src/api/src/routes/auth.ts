/**
 * WebAuthn / passkey auth routes.
 *
 * Phase A: bootstrap probe + registration (claim path / invited member path).
 * Tasks A8/A9/A10 will append login/refresh/logout, credential management,
 * and invite endpoints to this same chain.
 */

import { Elysia, t } from "elysia";
import {
  usersCollection,
  credentialsCollection,
  invitesCollection,
} from "../db/client.ts";
import {
  buildRegistrationOptions,
  verifyRegistration,
  consumeChallenge,
} from "../auth/webauthn.ts";
import { redeemInvite } from "../auth/invites.ts";
import { signAccessToken } from "../auth/tokens.ts";
import { issueRefreshToken } from "../auth/refresh_store.ts";

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
    async ({ body, set }) => {
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
    async ({ body, set }) => {
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
  );
