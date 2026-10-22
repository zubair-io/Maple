/**
 * Native PKCE code exchange (#856): a signed-in web page mints a one-time code
 * bound to a PKCE challenge, and the Apple shell redeems it — with the
 * verifier — for its own device-scoped tokens.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787), so the refresh token counted after a redeem is the one
 * that redeem minted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import type { ObjectId } from '../../src/db/object-id.ts';
import { authRoutes } from '../../src/routes/auth.ts';
import {
  nativeCodeRedeemRoutes,
  nativeCodeIssueRoutes,
} from '../../src/routes/auth-native-code.ts';
import { signAccessToken, signStepUpToken } from '../../src/auth/tokens.ts';
import { issueRefreshToken } from '../../src/auth/refresh_store.ts';
import { pkceS256 } from '../../src/auth/native_code_store.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { seedUser } from '../helpers/sqlite-fixtures.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const app = new Elysia()
  .use(authRoutes)
  .use(nativeCodeRedeemRoutes)
  // Mirror index.ts: wrap the self-gating issue route so its `requireAuth`
  // scoped-derive stays contained and doesn't gate the public redeem.
  .use(new Elysia().use(nativeCodeIssueRoutes));

let live: LiveTestDatabase;
let userId: ObjectId;
let bearer: string;
let refreshCookie: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  userId = seedUser(live.db, { email: 'owner@maple.local', role: 'owner' });
  bearer = await signAccessToken(
    { file_access: true, sub: userId.toHexString(), email: 'owner@maple.local', role: 'owner' },
    process.env.MAPLE_JWT_SECRET!,
  );
  const primary = await issueRefreshToken(userId, 'browser');
  refreshCookie = `maple_refresh=${primary.raw}`;
});

afterEach(() => {
  live.close();
});

/** How many refresh tokens this account holds. */
function refreshTokenCount(): number {
  const row = live.db
    .query(`SELECT count(*) AS n FROM refresh_tokens WHERE user_id = ?`)
    .get(userId.toHexString()) as { n: number };
  return row.n;
}

const issue = (headers: Record<string, string>, challenge: string, state = 'state-abcdef') =>
  app.handle(
    new Request('http://localhost/api/auth/native-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ code_challenge: challenge, state }),
    }),
  );

const redeem = (code: string, verifier: string) =>
  app.handle(
    new Request('http://localhost/api/auth/native-code/redeem', {
      method: 'POST',
      // Distinct IP so these (rate-limited) redeems use their own bucket and
      // don't consume the shared `auth:anon` budget other auth tests rely on.
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
      body: JSON.stringify({ code, code_verifier: verifier }),
    }),
  );

describe('native code exchange (#856)', () => {
  for (const cookieKind of ['expired', 'paired device', 'different account'] as const) {
    it(`accepts a live body proof despite a ${cookieKind} cookie`, async () => {
      const primary = await issueRefreshToken(userId, 'body browser');
      const otherUser =
        cookieKind === 'different account'
          ? seedUser(live.db, { email: 'other@maple.local', role: 'user' })
          : userId;
      const cookie =
        cookieKind === 'expired'
          ? 'stale-token'
          : (
              await issueRefreshToken(
                otherUser,
                'cookie browser',
                cookieKind === 'paired device' ? { platform: 'tvos' } : undefined,
              )
            ).raw;
      const response = await app.handle(
        new Request('http://localhost/api/auth/native-code', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${bearer}`,
            cookie: `maple_refresh=${cookie}`,
          },
          body: JSON.stringify({
            refresh_token: primary.raw,
            code_challenge: pkceS256('body-proof-verifier-1234567890-abcdefghijkl'),
            state: 'body-proof-state',
          }),
        }),
      );
      expect(response.status).toBe(200);
    });
  }

  it('retains valid cookie proof when an invalid body token is supplied', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/auth/native-code', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearer}`,
          cookie: refreshCookie,
        },
        body: JSON.stringify({
          refresh_token: 'stale-token',
          code_challenge: pkceS256('body-proof-verifier-1234567890-abcdefghijkl'),
          state: 'body-proof-state',
        }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it('POST /native-code requires a bearer', async () => {
    const r = await issue({}, pkceS256('v-some-verifier'));
    expect(r.status).toBe(401);
  });

  it('rejects an access-only JWT with 403 when neither a live primary refresh token nor step-up is presented (#4673)', async () => {
    const verifier = 'access-only-verifier-1234567890-abcdefghijkl';
    const r = await issue({ authorization: `Bearer ${bearer}` }, pkceS256(verifier));
    expect(r.status).toBe(403);
    expect(refreshTokenCount()).toBe(1);
  });

  it('rejects a paired-device refresh token (non-primary) as proof (#4673)', async () => {
    const tv = await issueRefreshToken(userId, 'Apple TV', { platform: 'tvos' });
    const verifier = 'tv-refresh-verifier-1234567890-abcdefghijklm';
    const r = await issue(
      { authorization: `Bearer ${bearer}`, cookie: `maple_refresh=${tv.raw}` },
      pkceS256(verifier),
    );
    expect(r.status).toBe(403);
  });

  it('accepts a valid X-Step-Up header when no refresh token is presented (#4673)', async () => {
    const stepUp = await signStepUpToken(userId.toHexString(), process.env.MAPLE_JWT_SECRET!);
    const verifier = 'step-up-verifier-1234567890-abcdefghijklmnop';
    const r = await issue(
      { authorization: `Bearer ${bearer}`, 'x-step-up': stepUp },
      pkceS256(verifier),
    );
    expect(r.status).toBe(200);
  });

  it('issues a code (authed + primary refresh proof) and redeems it for fresh device-scoped tokens', async () => {
    const verifier = 'the-verifier-value-1234567890';
    const issueRes = await issue(
      { authorization: `Bearer ${bearer}`, cookie: refreshCookie },
      pkceS256(verifier),
    );
    expect(issueRes.status).toBe(200);
    const { code } = (await issueRes.json()) as { code: string };
    expect(typeof code).toBe('string');

    const redeemRes = await redeem(code, verifier);
    expect(redeemRes.status).toBe(200);
    const body = (await redeemRes.json()) as {
      access_token: string;
      refresh_token: string;
      user: { id: string };
      state: string;
    };
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.user.id).toBe(userId.toHexString());
    expect(body.state).toBe('state-abcdef');

    // A fresh device-scoped refresh token was minted alongside the browser's primary token.
    expect(refreshTokenCount()).toBe(2);

    // Single-use: a replay of the same code fails.
    const reuse = await redeem(code, verifier);
    expect(reuse.status).toBe(400);
  });

  it('rejects redeem with a wrong verifier', async () => {
    const issueRes = await issue(
      { authorization: `Bearer ${bearer}`, cookie: refreshCookie },
      pkceS256('right-verifier-xyz'),
    );
    const { code } = (await issueRes.json()) as { code: string };
    const r = await redeem(code, 'wrong-verifier-xyz');
    expect(r.status).toBe(400);
  });

  it('rejects a malformed code_challenge', async () => {
    const r = await issue(
      { authorization: `Bearer ${bearer}`, cookie: refreshCookie },
      'too-short',
    );
    expect(r.status).toBe(400);
  });
});
