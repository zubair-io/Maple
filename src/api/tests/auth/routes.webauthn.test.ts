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
 *   5. Re-using the original refresh_token → 4xx (replay rejected)
 */

process.env.MAPLE_RP_ID = "localhost";
process.env.MAPLE_ORIGIN = "http://localhost:3000";
process.env.MAPLE_JWT_SECRET = "x".repeat(32);

import { describe, it, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { authRoutes } from "../../src/routes/auth.ts";
import {
  usersCollection,
  credentialsCollection,
  invitesCollection,
  refreshTokensCollection,
  challengesCollection,
} from "../../src/db/client.ts";
import { buildRegistrationResponse } from "./helpers/soft-authn.ts";

const app = new Elysia().use(authRoutes);

const RP_ID = "localhost";
const ORIGIN = "http://localhost:3000";

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
});

async function postJson(path: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("WebAuthn end-to-end", () => {
  it("claim → sign in → refresh → reuse-detection", async () => {
    const email = "owner@maple.test";

    // 1. Bootstrap probe — fresh DB, nobody has claimed yet.
    const bootstrap = await app.handle(
      new Request("http://localhost/api/auth/bootstrap")
    );
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toEqual({ claimed: false });

    // 2a. Registration options.
    const regOptsRes = await postJson("/api/auth/register/options", { email });
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
    const regVerifyRes = await postJson("/api/auth/register/verify", {
      email,
      device_label: "test-laptop",
      credential: built.response,
    });
    expect(regVerifyRes.status).toBe(200);
    const regBody = (await regVerifyRes.json()) as {
      access_token: string;
      refresh_token: string;
      user: { id: string; email: string; role: "owner" | "member" };
    };
    expect(regBody.user.email).toBe(email);
    expect(regBody.user.role).toBe("owner");
    expect(regBody.access_token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(typeof regBody.refresh_token).toBe("string");
    expect(regBody.refresh_token.length).toBeGreaterThan(20);

    // Sanity: persisted credential matches the soft-authenticator id.
    const persisted = await (await credentialsCollection()).findOne({
      credential_id: authenticator.credentialId,
    });
    expect(persisted).not.toBeNull();

    // 3a. Login options for the same email.
    const loginOptsRes = await postJson("/api/auth/login/options", { email });
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
    const loginVerifyRes = await postJson("/api/auth/login/verify", {
      email,
      credential: assertion,
    });
    expect(loginVerifyRes.status).toBe(200);
    const loginBody = (await loginVerifyRes.json()) as {
      access_token: string;
      refresh_token: string;
      user: { id: string; email: string; role: "owner" | "member" };
    };
    expect(loginBody.user.role).toBe("owner");
    expect(typeof loginBody.refresh_token).toBe("string");
    expect(loginBody.refresh_token).not.toBe(regBody.refresh_token);

    // 4. Refresh — must rotate the refresh token.
    const originalRefresh = loginBody.refresh_token;
    const refreshRes = await postJson("/api/auth/refresh", {
      refresh_token: originalRefresh,
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = (await refreshRes.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(refreshBody.refresh_token).not.toBe(originalRefresh);
    expect(refreshBody.access_token).toBeDefined();

    // 5. Re-using the now-revoked original refresh token must fail (4xx).
    const replayRes = await postJson("/api/auth/refresh", {
      refresh_token: originalRefresh,
    });
    expect(replayRes.status).toBeGreaterThanOrEqual(400);
    expect(replayRes.status).toBeLessThan(500);
  });
});
