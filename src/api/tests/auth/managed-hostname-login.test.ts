/**
 * Signing in at the managed LAN HTTPS hostname (#3519).
 *
 * The hostname is configured in Settings → Network at runtime, so a passkey
 * asserted there must verify without the operator adding it to MAPLE_ORIGIN
 * and restarting. A hostname the server is NOT serving stays rejected — the
 * allowlist follows the live listener, not anything a client claims.
 *
 * Storage is a private SQLite database installed as the process-wide handle for
 * each test (#3787), so each test claims a fresh server with its own passkey.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { buildApp } from '../../src/index.ts';
import { managedHttps } from '../../src/network/managed-https.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { buildRegistrationResponse, type SoftAuthenticator } from './helpers/soft-authn.ts';

/**
 * Claim an environment variable for this suite only, restoring whatever the
 * process had before.
 *
 * Every other auth suite registers its passkeys at `localhost`; this one is
 * about a different hostname entirely, and Bun evaluates every test file's
 * module body before any test runs — so setting these at module scope would
 * hand `maple.test` to the whole run. Claiming them in `beforeAll` and putting
 * them back in `afterAll` keeps the difference inside this file.
 */
function withSuiteEnv(name: string, value: string): void {
  let prior: string | undefined;
  beforeAll(() => {
    prior = process.env[name];
    process.env[name] = value;
  });
  afterAll(() => {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  });
}

withSuiteEnv('MAPLE_RP_ID', 'maple.test');
withSuiteEnv('MAPLE_ORIGIN', 'https://maple.test');
withSuiteEnv('MAPLE_JWT_SECRET', 'x'.repeat(32));

const RP_ID = 'maple.test';
const PUBLIC_ORIGIN = 'https://maple.test';
const LOCAL_HOSTNAME = 'local.maple.test';
const app = buildApp({ stageNames: [] });
const endpoint = spyOn(managedHttps, 'endpoint');

let live: LiveTestDatabase;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  endpoint.mockReturnValue({ ip: LOCAL_HOSTNAME, port: 443, scheme: 'https' });
});

afterEach(() => {
  live.close();
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
