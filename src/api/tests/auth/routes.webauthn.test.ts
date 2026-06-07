/**
 * End-to-end WebAuthn ceremony test (Task A14).
 *
 * Drives the full happy path against the real Elysia auth router with a
 * hand-rolled soft authenticator (see ./helpers/soft-authn.ts):
 *   1. GET /api/auth/bootstrap → claimed=false
 *   2. POST /api/auth/register/options → soft-authn signs attestation →
 *      POST /api/auth/register/verify → owner role + tokens
 *   3. POST /api/auth/login/options → soft-authn signs assertion →
 *      POST /api/auth/login/verify → tokens
 *   4. POST /api/auth/refresh with the refresh_token → new pair, refresh
 *      token rotated
 *   5. Replaying the original refresh_token within the grace window → 200
 *      re-mint (benign retry, NOT a logout) — #858
 *   6. After logout revokes the family, replaying it → 401 (genuine reuse
 *      rejected; logout actually logs out) — #858
 */

process.env.MAPLE_RP_ID = 'localhost';
process.env.MAPLE_ORIGIN = 'http://localhost:3000';
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

import { describe, it, expect, beforeEach } from 'bun:test';
import { Elysia } from 'elysia';
import { authRoutes } from '../../src/routes/auth.ts';
import {
  usersCollection,
  credentialsCollection,
  invitesCollection,
  refreshTokensCollection,
  challengesCollection,
  serverStateCollection,
} from '../../src/db/client.ts';
import { OWNER_CLAIM_ID } from '../../src/auth/server_claim.ts';
import { buildRegistrationResponse } from './helpers/soft-authn.ts';

const app = new Elysia().use(authRoutes);

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';

beforeEach(async () => {
  for (const c of [
    usersCollection,
    credentialsCollection,
    invitesCollection,
    refreshTokensCollection,
    challengesCollection,
  ]) {
    await (await c()).deleteMany({});
  }
  // #865: clear the ownership-claim sentinel so the claim ceremony starts fresh.
  await (await serverStateCollection()).deleteOne({ _id: OWNER_CLAIM_ID });
});

async function postJson(path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // Pin a source IP so this file's auth calls use their own rate-limit
    // bucket (`auth:${ip}`, 10/min) — the in-memory limiter is shared across
    // every test file in a run, and the #858 reuse flow adds refresh calls.
    'x-forwarded-for': '198.51.100.50',
  };
  // Drive refresh/logout through the rotating httpOnly cookie, exactly as the
  // web client does (the refresh handler only re-sets the cookie when the
  // request authenticated via cookie — #857/#858).
  if (cookie) headers['cookie'] = `maple_refresh=${cookie}`;
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/** Extract the rotating `maple_refresh` value from a response's Set-Cookie.
 * Post-#857 the refresh token rides ONLY in the httpOnly cookie, not the JSON. */
function refreshCookie(res: Response): string {
  const sc = res.headers.get('set-cookie') ?? '';
  return /maple_refresh=([^;]+)/.exec(sc)?.[1] ?? '';
}

describe('WebAuthn end-to-end', () => {
  it('claim → sign in → refresh → reuse-detection', async () => {
    const email = 'owner@maple.test';

    // 1. Bootstrap probe — fresh DB, nobody has claimed yet.
    const bootstrap = await app.handle(new Request('http://localhost/api/auth/bootstrap'));
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toEqual({ claimed: false, dev_login_enabled: false });

    // 2a. Registration options.
    const regOptsRes = await postJson('/api/auth/register/options', { email });
    expect(regOptsRes.status).toBe(200);
    const regOpts = (await regOptsRes.json()) as { challenge: string };
    expect(regOpts.challenge).toBeDefined();

    // 2b. Soft authenticator builds the attestation.
    const built = await buildRegistrationResponse({
      challenge: regOpts.challenge,
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const authenticator = built.authenticator;

    // 2c. Verify registration.
    const regVerifyRes = await postJson('/api/auth/register/verify', {
      email,
      device_label: 'test-laptop',
      credential: built.response,
    });
    expect(regVerifyRes.status).toBe(200);
    const regBody = (await regVerifyRes.json()) as {
      access_token: string;
      user: { id: string; email: string; role: 'owner' | 'member' };
    };
    expect(regBody.user.email).toBe(email);
    expect(regBody.user.role).toBe('owner');
    expect(regBody.access_token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // #857: the refresh token rides ONLY in the httpOnly cookie, not the JSON body.
    expect((regBody as { refresh_token?: string }).refresh_token).toBeUndefined();
    const regRefresh = refreshCookie(regVerifyRes);
    expect(regRefresh.length).toBeGreaterThan(20);

    // Sanity: persisted credential matches the soft-authenticator id.
    const persisted = await (
      await credentialsCollection()
    ).findOne({
      credential_id: authenticator.credentialId,
    });
    expect(persisted).not.toBeNull();

    // 3a. Login options for the same email.
    const loginOptsRes = await postJson('/api/auth/login/options', { email });
    expect(loginOptsRes.status).toBe(200);
    const loginOpts = (await loginOptsRes.json()) as { challenge: string };
    expect(loginOpts.challenge).toBeDefined();

    // 3b. Soft authenticator builds the assertion.
    const assertion = await authenticator.buildAssertion({
      challenge: loginOpts.challenge,
      rpId: RP_ID,
      origin: ORIGIN,
    });

    // 3c. Verify login.
    const loginVerifyRes = await postJson('/api/auth/login/verify', {
      email,
      credential: assertion,
    });
    expect(loginVerifyRes.status).toBe(200);
    const loginBody = (await loginVerifyRes.json()) as {
      access_token: string;
      user: { id: string; email: string; role: 'owner' | 'member' };
    };
    expect(loginBody.user.role).toBe('owner');
    const loginRefresh = refreshCookie(loginVerifyRes);
    expect(loginRefresh.length).toBeGreaterThan(20);
    expect(loginRefresh).not.toBe(regRefresh);

    // 4. Refresh through the rotating httpOnly cookie (the real web path) —
    //    rotates to a new token (#858 atomic CAS).
    const r0 = loginRefresh;
    const refreshRes = await postJson('/api/auth/refresh', {}, r0);
    expect(refreshRes.status).toBe(200);
    const refreshBody = (await refreshRes.json()) as { access_token: string };
    expect(refreshBody.access_token).toBeDefined();
    // #857: no refresh_token in the body; the rotated token rides in the cookie.
    expect((refreshBody as { refresh_token?: string }).refresh_token).toBeUndefined();
    const r1 = refreshCookie(refreshRes);
    expect(r1).not.toBe(r0);

    // 5. Replaying the just-rotated r0 WITHIN the grace window is a benign
    //    lost-response / concurrent retry — it RE-MINTS (200) rather than
    //    revoking the session. Returning 4xx here was the original "refresh
    //    token reuse detected — chain revoked" logout bug (#858).
    const regrantRes = await postJson('/api/auth/refresh', {}, r0);
    expect(regrantRes.status).toBe(200);
    const r2 = refreshCookie(regrantRes);
    expect(r2).not.toBe(r0);

    // 6. Genuine reuse is still rejected: logout revokes the WHOLE device
    //    family, so every token in it — the rotated head and the re-mint —
    //    then 401s (#858 revokeFamilyByToken). Logout actually logs out.
    expect((await postJson('/api/auth/logout', {}, r2)).status).toBe(204);
    expect((await postJson('/api/auth/refresh', {}, r1)).status).toBe(401);
    expect((await postJson('/api/auth/refresh', {}, r2)).status).toBe(401);
  });
});
