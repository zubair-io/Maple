// src/api/src/routes/auth-account.ts
//
// Authenticated account self-service. Extracted from auth.ts (#861) to keep that
// file under the line budget. Holds: /me, WebAuthn step-up re-auth, and
// credential management. Mounted separately (wrapped) in index.ts so
// requireAuth's scoped derive stays contained — same pattern as
// auth-native-code.ts.
import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { usersCollection, credentialsCollection } from '../db/client.ts';
import {
  buildRegistrationOptions,
  verifyRegistration,
  consumeChallenge,
  buildAuthenticationOptions,
  verifyAuthentication,
} from '../auth/webauthn.ts';
import { signStepUpToken, STEP_UP_TTL_SECONDS } from '../auth/tokens.ts';
import { requireAuth, stepUpBeforeHandle } from '../auth/middleware.ts';
import { userFileAccess } from '../auth/permissions.ts';

function jwtSecret(): string {
  const s = process.env.MAPLE_JWT_SECRET;
  if (!s || s.length < 16) throw new Error('MAPLE_JWT_SECRET unset or too short');
  return s;
}

export const accountRoutes = new Elysia({ prefix: '/api/auth' })
  .use(requireAuth)
  .get('/me', async ({ auth }) => {
    const userId = new ObjectId(auth.user.sub);
    const user = await (await usersCollection()).findOne({ _id: userId });
    const creds = await (
      await credentialsCollection()
    )
      .find(
        { user_id: userId },
        {
          projection: {
            _id: 1,
            device_label: 1,
            last_used_at: 1,
            created_at: 1,
          },
        },
      )
      .toArray();
    return {
      user: user
        ? {
            id: user._id.toHexString(),
            email: user.email,
            role: user.role,
            file_access: userFileAccess(user),
          }
        : null,
      credentials: creds.map((c) => ({
        id: c._id.toHexString(),
        device_label: c.device_label,
        last_used_at: c.last_used_at,
        created_at: c.created_at,
      })),
    };
  })

  // ----- step-up re-auth (#861) -----
  // A fresh WebAuthn assertion → a short-lived step-up token, required by the
  // sensitive actions below. Options issues an assertion challenge for the
  // already-authenticated user; verify checks it and mints the token.
  .post('/step-up/options', async ({ auth }) =>
    buildAuthenticationOptions(new ObjectId(auth.user.sub), auth.user.email),
  )
  .post(
    '/step-up/verify',
    async ({ auth, body, set }) => {
      const userId = new ObjectId(auth.user.sub);
      const clientChallenge = body.credential?.response?.clientDataJSON
        ? JSON.parse(Buffer.from(body.credential.response.clientDataJSON, 'base64url').toString())
            .challenge
        : '';
      let challengeRow;
      try {
        challengeRow = await consumeChallenge(clientChallenge);
      } catch {
        set.status = 400;
        return { error: 'challenge invalid' };
      }
      if (
        challengeRow.purpose !== 'authenticate' ||
        !challengeRow.user_id ||
        !challengeRow.user_id.equals(userId)
      ) {
        set.status = 400;
        return { error: 'challenge mismatch' };
      }
      const credsColl = await credentialsCollection();
      const credentialId = body.credential?.id;
      const cred = credentialId ? await credsColl.findOne({ credential_id: credentialId }) : null;
      if (!cred || !cred.user_id.equals(userId)) {
        set.status = 400;
        return { error: 'unknown credential' };
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
      await credsColl.updateOne(
        { _id: cred._id },
        {
          $set: {
            counter: verification.authenticationInfo.newCounter,
            last_used_at: new Date().toISOString(),
          },
        },
      );
      const step_up_token = await signStepUpToken(userId.toHexString(), jwtSecret());
      return { step_up_token, expires_in: STEP_UP_TTL_SECONDS };
    },
    { body: t.Object({ credential: t.Any() }) },
  )

  // ----- add another credential -----
  .post('/credentials/options', async ({ auth }) => {
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
    '/credentials/verify',
    async ({ auth, body, set }) => {
      const userId = new ObjectId(auth.user.sub);
      const clientChallenge = body.credential?.response?.clientDataJSON
        ? JSON.parse(Buffer.from(body.credential.response.clientDataJSON, 'base64url').toString())
            .challenge
        : '';
      const challengeRow = await consumeChallenge(clientChallenge);
      if (
        challengeRow.purpose !== 'add_credential' ||
        !challengeRow.user_id ||
        !challengeRow.user_id.equals(userId)
      ) {
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
      // #861: adding a credential is sensitive — require a fresh step-up.
      beforeHandle: stepUpBeforeHandle,
    },
  )

  .delete(
    '/credentials/:id',
    async ({ auth, params, set }) => {
      const userId = new ObjectId(auth.user.sub);
      const c = await credentialsCollection();
      const count = await c.countDocuments({ user_id: userId });
      if (count <= 1) {
        set.status = 409;
        return { error: 'cannot remove last credential' };
      }
      const r = await c.deleteOne({
        _id: new ObjectId(params.id),
        user_id: userId,
      });
      if (r.deletedCount === 0) {
        set.status = 404;
        return { error: 'not found' };
      }
      return new Response(null, { status: 204 });
    },
    {
      // #861: removing a credential is sensitive — require a fresh step-up.
      beforeHandle: stepUpBeforeHandle,
    },
  );
