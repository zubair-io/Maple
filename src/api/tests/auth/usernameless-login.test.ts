/**
 * Usernameless / discoverable-passkey login (#1304).
 *
 * Sign in with NO email: login/options issues a discoverable challenge (empty
 * allowCredentials), the authenticator asserts a resident passkey, and
 * login/verify identifies the account from the asserted credential id. The
 * email-scoped path is kept as a fallback.
 */
process.env.MAPLE_RP_ID = 'localhost';
process.env.MAPLE_ORIGIN = 'http://localhost:3000';
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

import { describe, it, expect, beforeEach } from 'bun:test';
import { buildApp } from '../../src/index.ts';
import {
  usersCollection,
  credentialsCollection,
  challengesCollection,
  refreshTokensCollection,
  serverStateCollection,
} from '../../src/db/client.ts';
import { OWNER_CLAIM_ID } from '../../src/auth/server_claim.ts';
import { buildRegistrationResponse, type SoftAuthenticator } from './helpers/soft-authn.ts';

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const app = buildApp({ stageNames: [] });

beforeEach(async () => {
  for (const c of [
    usersCollection,
    credentialsCollection,
    challengesCollection,
    refreshTokensCollection,
  ]) {
    await (await c()).deleteMany({});
  }
  await (await serverStateCollection()).deleteOne({ _id: OWNER_CLAIM_ID });
});

function post(path: string, body: unknown, ip: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    }),
  );
}

/** Claim the server with a resident passkey; return the soft authenticator. */
async function claim(email: string, ip: string): Promise<SoftAuthenticator> {
  const optsRes = await post('/api/auth/register/options', { email }, ip);
  const { challenge } = (await optsRes.json()) as { challenge: string };
  const built = await buildRegistrationResponse({ challenge, rpId: RP_ID, origin: ORIGIN });
  await post(
    '/api/auth/register/verify',
    { email, device_label: 'laptop', credential: built.response },
    ip,
  );
  return built.authenticator;
}

describe('usernameless login (#1304)', () => {
  it('signs in with NO email via a discoverable credential', async () => {
    const ip = '198.51.100.70';
    const authr = await claim('owner@maple.test', ip);

    // No email → discoverable options (empty allowCredentials).
    const optsRes = await post('/api/auth/login/options', {}, ip);
    expect(optsRes.status).toBe(200);
    const opts = (await optsRes.json()) as { challenge: string; allowCredentials?: unknown[] };
    expect(opts.challenge).toBeDefined();
    expect(opts.allowCredentials ?? []).toHaveLength(0);

    const assertion = await authr.buildAssertion({
      challenge: opts.challenge,
      rpId: RP_ID,
      origin: ORIGIN,
    });

    // No email at verify either — identified by the asserted credential id.
    const verifyRes = await post('/api/auth/login/verify', { credential: assertion }, ip);
    expect(verifyRes.status).toBe(200);
    const body = (await verifyRes.json()) as { access_token?: string; user?: { email: string } };
    expect(body.access_token).toBeDefined();
    expect(body.user?.email).toBe('owner@maple.test');
  });

  it('issues discoverable options regardless of any supplied email', async () => {
    const ip = '198.51.100.71';
    const email = 'owner@maple.test';
    await claim(email, ip); // a resident credential now exists for this email

    // Login is pure passkey: a registered email must NOT scope the options —
    // allowCredentials stays empty so no email-keyed credential list leaks.
    const knownRes = await post('/api/auth/login/options', { email }, ip);
    expect(knownRes.status).toBe(200);
    const known = (await knownRes.json()) as { allowCredentials?: unknown[] };
    expect(known.allowCredentials ?? []).toHaveLength(0);

    // An unknown email must NOT 404 — there is no account-existence oracle.
    const unknownRes = await post('/api/auth/login/options', { email: 'ghost@nope.io' }, ip);
    expect(unknownRes.status).toBe(200);
  });
});
