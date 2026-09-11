/**
 * Signing in at the managed LAN HTTPS hostname (#3519).
 *
 * The hostname is configured in Settings → Network at runtime, so a passkey
 * asserted there must verify without the operator adding it to MAPLE_ORIGIN
 * and restarting. A hostname the server is NOT serving stays rejected — the
 * allowlist follows the live listener, not anything a client claims.
 */
process.env.MAPLE_RP_ID = 'maple.test';
process.env.MAPLE_ORIGIN = 'https://maple.test';
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

import { describe, it, expect, beforeEach, afterAll, spyOn } from 'bun:test';
import { buildApp } from '../../src/index.ts';
import {
  usersCollection,
  credentialsCollection,
  challengesCollection,
  refreshTokensCollection,
  serverStateCollection,
} from '../../src/db/client.ts';
import { OWNER_CLAIM_ID } from '../../src/auth/server_claim.ts';
import { managedHttps } from '../../src/network/managed-https.ts';
import { buildRegistrationResponse, type SoftAuthenticator } from './helpers/soft-authn.ts';

const RP_ID = 'maple.test';
const PUBLIC_ORIGIN = 'https://maple.test';
const LOCAL_HOSTNAME = 'local.maple.test';
const app = buildApp({ stageNames: [] });
const endpoint = spyOn(managedHttps, 'endpoint');

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
  endpoint.mockReturnValue({ ip: LOCAL_HOSTNAME, port: 443, scheme: 'https' });
});
afterAll(() => endpoint.mockRestore());

function post(path: string, body: unknown, ip: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    }),
  );
}

/** Claim the server with a resident passkey registered at the public origin. */
async function claim(email: string, ip: string): Promise<SoftAuthenticator> {
  const optsRes = await post('/api/auth/register/options', { email }, ip);
  const { challenge } = (await optsRes.json()) as { challenge: string };
  const built = await buildRegistrationResponse({ challenge, rpId: RP_ID, origin: PUBLIC_ORIGIN });
  await post(
    '/api/auth/register/verify',
    { email, device_label: 'laptop', credential: built.response },
    ip,
  );
  return built.authenticator;
}

async function signInFrom(authr: SoftAuthenticator, origin: string, ip: string): Promise<Response> {
  const optsRes = await post('/api/auth/login/options', {}, ip);
  const { challenge } = (await optsRes.json()) as { challenge: string };
  const assertion = await authr.buildAssertion({ challenge, rpId: RP_ID, origin });
  return post('/api/auth/login/verify', { credential: assertion }, ip);
}

describe('sign-in at the managed HTTPS hostname (#3519)', () => {
  it('accepts a passkey asserted at the hostname the managed listener is serving', async () => {
    const ip = '198.51.100.80';
    const authr = await claim('owner@maple.test', ip);
    // Registered at the public origin, asserted at the local hostname — the
    // handoff case, and what a user hitting the LAN address directly does.
    const res = await signInFrom(authr, `https://${LOCAL_HOSTNAME}`, ip);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token?: string };
    expect(body.access_token).toBeDefined();
  });

  it('rejects a hostname the managed listener is not serving', async () => {
    const ip = '198.51.100.81';
    const authr = await claim('owner@maple.test', ip);
    const res = await signInFrom(authr, 'https://evil.maple.test', ip);
    expect(res.status).not.toBe(200);
  });

  it('rejects the managed hostname once the listener stops serving it', async () => {
    const ip = '198.51.100.82';
    const authr = await claim('owner@maple.test', ip);
    endpoint.mockReturnValue(null);
    const res = await signInFrom(authr, `https://${LOCAL_HOSTNAME}`, ip);
    expect(res.status).not.toBe(200);
  });
});
