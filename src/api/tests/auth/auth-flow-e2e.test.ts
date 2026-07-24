/**
 * Auth lifecycle — end-to-end (the #852 stack: #872 backup-gate + #907
 * native-PKCE + #858 rotation core).
 *
 * Drives the REAL assembled app (`buildApp` — the same mount as production
 * `index.ts`: the `requireAuth` sub-app containment and the wrapped native-code
 * issue route) over HTTP against a real Mongo. This proves the pieces COMPOSE,
 * not just that each unit works in isolation:
 *
 *  - claim issues an access token + httpOnly refresh cookie, with NO
 *    `refresh_token` in the JSON body (#857)
 *  - `/refresh` rotates the cookie (#858 atomic CAS)
 *  - a within-grace replay of a just-rotated cookie RE-MINTS (200) instead of
 *    nuking the session — the original "refresh token reuse detected — chain
 *    revoked" logout bug, fixed (#858 family-liveness grace)
 *  - logout revokes the whole device family, so every token in it then 401s
 *    (#858 `revokeFamilyByToken`) — a single `revokeOne` would leave a
 *    re-minted sibling live
 *  - a second device's family survives the first device's logout (#858 family
 *    scope) — the old per-user `revokeChain` would sign every device out
 *  - native PKCE: authed issue → public redeem → device-scoped tokens, and a
 *    code is single-use (#856)
 *  - the six PhotoKit-backup routes 401 without a bearer and pass auth with one
 *    (#853 gate)
 *
 * Each scenario uses a distinct `x-forwarded-for` so the shared `auth:${ip}`
 * 10/min limiter (register/login verify + refresh + redeem all share it) never
 * trips across scenarios.
 */
process.env.MAPLE_RP_ID = 'localhost';
process.env.MAPLE_ORIGIN = 'http://localhost:3000';
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

import { describe, it, expect, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { buildApp } from '../../src/index.ts';
import { signAccessToken } from '../../src/auth/tokens.ts';
import { pkceS256 } from '../../src/auth/native_code_store.ts';
import {
  usersCollection,
  credentialsCollection,
  invitesCollection,
  refreshTokensCollection,
  challengesCollection,
  nativeAuthCodesCollection,
  lanHandoffCodesCollection,
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
    invitesCollection,
    refreshTokensCollection,
    challengesCollection,
    nativeAuthCodesCollection,
    lanHandoffCodesCollection,
  ]) {
    await (await c()).deleteMany({});
  }
  // #865: clear the ownership-claim sentinel so each scenario can claim fresh.
  await (await serverStateCollection()).deleteOne({ _id: OWNER_CLAIM_ID });
});

// --- HTTP helpers -----------------------------------------------------------

/** Pull the rotating `maple_refresh` value out of a response's Set-Cookie. */
function setCookie(res: Response): string {
  const sc = res.headers.get('set-cookie') ?? '';
  return /maple_refresh=([^;]+)/.exec(sc)?.[1] ?? '';
}

interface PostOpts {
  ip: string;
  cookie?: string;
  bearer?: string;
}

/** POST JSON with a per-scenario source IP (own rate-limit bucket). */
function post(path: string, body: unknown, opts: PostOpts): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': opts.ip,
  };
  if (opts.cookie) headers['cookie'] = `maple_refresh=${opts.cookie}`;
  if (opts.bearer) headers['authorization'] = `Bearer ${opts.bearer}`;
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/** Full passkey claim ceremony for a fresh (owner) account. */
async function claim(email: string, ip: string, deviceLabel = 'device') {
  const optsRes = await post('/api/auth/register/options', { email }, { ip });
  const { challenge } = (await optsRes.json()) as { challenge: string };
  const built = await buildRegistrationResponse({ challenge, rpId: RP_ID, origin: ORIGIN });
  const verifyRes = await post(
    '/api/auth/register/verify',
    { email, device_label: deviceLabel, credential: built.response },
    { ip },
  );
  const body = (await verifyRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    user?: { id: string; email: string; role: string };
  };
  return {
    res: verifyRes,
    body,
    cookie: setCookie(verifyRes),
    authenticator: built.authenticator,
  };
}

/** Sign in an already-registered credential (a second device / family). */
async function loginExisting(authenticator: SoftAuthenticator, ip: string) {
  // Pure passkey (#1377): login sends no email — the discoverable assertion
  // identifies the account by its credential id.
  const optsRes = await post('/api/auth/login/options', {}, { ip });
  const { challenge } = (await optsRes.json()) as { challenge: string };
  const assertion = await authenticator.buildAssertion({ challenge, rpId: RP_ID, origin: ORIGIN });
  const verifyRes = await post('/api/auth/login/verify', { credential: assertion }, { ip });
  return { res: verifyRes, cookie: setCookie(verifyRes) };
}

const refresh = (cookie: string, ip: string) => post('/api/auth/refresh', {}, { ip, cookie });
const logout = (cookie: string, ip: string) => post('/api/auth/logout', {}, { ip, cookie });

// ---------------------------------------------------------------------------

describe('auth lifecycle e2e (#852 stack)', () => {
  it('claim → cookie rotates → within-grace replay re-mints → logout revokes the whole family', async () => {
    const ip = '198.51.100.1';
    const { res, body, cookie: r0 } = await claim('owner@maple.test', ip, 'laptop');

    // Claim issues a usable session.
    expect(res.status).toBe(200);
    expect(body.access_token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(body.user?.role).toBe('owner');
    // #857: the refresh token rides ONLY in the httpOnly cookie, never the body.
    expect(body.refresh_token).toBeUndefined();
    expect(r0.length).toBeGreaterThan(20);

    // /refresh rotates the cookie (#858 atomic CAS).
    const rot = await refresh(r0, ip);
    expect(rot.status).toBe(200);
    const r1 = setCookie(rot);
    expect(r1).not.toBe(r0);

    // Replaying the just-rotated r0 within the grace window RE-MINTS — it does
    // NOT trip reuse-detection and sign the user out. This is the original bug.
    const replay = await refresh(r0, ip);
    expect(replay.status).toBe(200);
    const r2 = setCookie(replay);
    expect(r2).not.toBe(r0);

    // Log out presenting one family token...
    expect((await logout(r2, ip)).status).toBe(204);

    // ...and the ENTIRE family is dead — both the rotated head and the re-mint.
    // (revokeOne would have left r1 alive; #858 revokes by family.)
    expect((await refresh(r1, ip)).status).toBe(401);
    expect((await refresh(r2, ip)).status).toBe(401);
  });

  it('logging out one device leaves another device signed in (family-scoped revoke)', async () => {
    const ipA = '198.51.100.2';
    const ipB = '198.51.100.3';
    const email = 'multi@maple.test';

    const { authenticator, cookie: a0 } = await claim(email, ipA, 'deviceA'); // family A
    const { cookie: b0 } = await loginExisting(authenticator, ipB); // family B
    expect(b0.length).toBeGreaterThan(20);
    expect(b0).not.toBe(a0);

    // Log out device A only.
    expect((await logout(a0, ipA)).status).toBe(204);

    // A is dead; B still rotates. The old per-user revokeChain would have
    // nuked B too the moment A's revoked token was replayed.
    expect((await refresh(a0, ipA)).status).toBe(401);
    expect((await refresh(b0, ipB)).status).toBe(200);
  });

  it('native PKCE: authed issue → public redeem → device-scoped tokens; the code is single-use', async () => {
    const ip = '198.51.100.4';
    const email = 'native@maple.test';
    const ins = await (
      await usersCollection()
    ).insertOne({
      email,
      role: 'owner',
      created_at: new Date().toISOString(),
      last_seen_at: null,
    });
    const bearer = await signAccessToken(
      { sub: ins.insertedId.toHexString(), email, role: 'owner' },
      process.env.MAPLE_JWT_SECRET!,
    );
    const verifier = 'v'.repeat(64);
    const challenge = pkceS256(verifier);

    // Issue requires a bearer (the wrapped, self-gating sub-app).
    expect(
      (
        await post(
          '/api/auth/native-code',
          { code_challenge: challenge, state: 'state-abcdef' },
          { ip },
        )
      ).status,
    ).toBe(401);

    const issueRes = await post(
      '/api/auth/native-code',
      { code_challenge: challenge, state: 'state-abcdef' },
      { ip, bearer },
    );
    expect(issueRes.status).toBe(200);
    const { code } = (await issueRes.json()) as { code: string };
    expect(code.length).toBeGreaterThan(10);

    // Redeem (public) with the PKCE verifier → device-scoped tokens. The raw
    // refresh token is returned ONLY here (never in a redirect URL).
    const redeemRes = await post(
      '/api/auth/native-code/redeem',
      { code, code_verifier: verifier },
      { ip },
    );
    expect(redeemRes.status).toBe(200);
    const redeemed = (await redeemRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      user?: { email: string };
    };
    expect(redeemed.access_token).toBeDefined();
    expect(redeemed.refresh_token).toBeDefined();
    expect(redeemed.user?.email).toBe(email);

    // Single-use: the same code cannot be redeemed twice.
    expect(
      (await post('/api/auth/native-code/redeem', { code, code_verifier: verifier }, { ip }))
        .status,
    ).toBe(400);
  });

  it('LAN-handoff session keeps rotating WITHOUT Secure — reload on the LAN origin does not sign the user out', async () => {
    // Regression for a bug where /refresh hardcoded `secure: true` when
    // re-setting the rotated cookie, even for a session established via the
    // LAN handoff (whose cookie is deliberately set WITHOUT `Secure` — see
    // auth-lan-handoff.ts, since the LAN origin only ever answers over plain
    // HTTP). A `Secure` cookie set over plain HTTP is silently dropped by the
    // browser, so the first rotation after the handoff wiped the session and
    // the next page reload found no cookie at all.
    const ip = '198.51.100.5';
    const { body } = await claim('lan@maple.test', ip, 'laptop');
    const bearer = body.access_token!;

    // Public HTTPS-domain page issues a one-time handoff code.
    const issueRes = await post('/api/auth/lan-handoff', {}, { ip, bearer });
    expect(issueRes.status).toBe(200);
    const { code } = (await issueRes.json()) as { code: string };

    // LAN-origin page redeems it for its OWN session.
    const redeemRes = await post('/api/auth/lan-handoff/redeem', { code }, { ip });
    expect(redeemRes.status).toBe(200);
    expect((redeemRes.headers.get('set-cookie') ?? '').toLowerCase()).not.toContain('secure');
    const lan0 = setCookie(redeemRes);

    // Rotate (e.g. the short-lived access token expired) — the re-set cookie
    // must STILL be non-Secure, not silently promoted back to Secure.
    const rot = await refresh(lan0, ip);
    expect(rot.status).toBe(200);
    expect((rot.headers.get('set-cookie') ?? '').toLowerCase()).not.toContain('secure');
    const lan1 = setCookie(rot);

    // And the rotated cookie — the one a reload would actually present —
    // keeps working.
    expect((await refresh(lan1, ip)).status).toBe(200);
  });

  it('PhotoKit-backup routes reject anonymous requests and pass auth with a bearer (#853 gate)', async () => {
    const LIB = new ObjectId().toHexString();
    const bearer = await signAccessToken(
      { sub: '0'.repeat(24), email: 'svc@maple.test', role: 'owner' },
      process.env.MAPLE_JWT_SECRET!,
    );
    const routes: ReadonlyArray<readonly [string, string]> = [
      ['POST', `/api/libraries/${LIB}/backup/ingest`],
      ['GET', `/api/libraries/${LIB}/backup/state`],
      ['POST', `/api/libraries/${LIB}/backup/exists`],
      ['POST', `/api/libraries/${LIB}/backup/sidecar`],
      ['POST', `/api/libraries/${LIB}/backup/rendered`],
      ['POST', `/api/libraries/${LIB}/backup/notify-deleted`],
    ];
    for (const [method, path] of routes) {
      const anon = await app.handle(new Request(`http://localhost${path}`, { method }));
      expect(anon.status).toBe(401);
      const authed = await app.handle(
        new Request(`http://localhost${path}`, {
          method,
          headers: { authorization: `Bearer ${bearer}` },
        }),
      );
      // Passes auth — may still 400/404 on missing fixtures, but never 401.
      expect(authed.status).not.toBe(401);
    }
  });
});
