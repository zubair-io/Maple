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
import type { ObjectId } from 'mongodb';
import { authRoutes } from '../../src/routes/auth.ts';
import {
  nativeCodeRedeemRoutes,
  nativeCodeIssueRoutes,
} from '../../src/routes/auth-native-code.ts';
import { signAccessToken } from '../../src/auth/tokens.ts';
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

beforeEach(async () => {
  live = await createLiveTestDatabase();
  userId = seedUser(live.db, { email: 'owner@maple.local', role: 'owner' });
  bearer = await signAccessToken(
    { file_access: true, sub: userId.toHexString(), email: 'owner@maple.local', role: 'owner' },
    process.env.MAPLE_JWT_SECRET!,
  );
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
  it('POST /native-code requires a bearer', async () => {
    const r = await issue({}, pkceS256('v-some-verifier'));
    expect(r.status).toBe(401);
  });

  it('issues a code (authed) and redeems it for fresh device-scoped tokens', async () => {
    const verifier = 'the-verifier-value-1234567890';
    const issueRes = await issue({ authorization: `Bearer ${bearer}` }, pkceS256(verifier));
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

    // A fresh device-scoped refresh token was minted (not the webview's token).
    expect(refreshTokenCount()).toBe(1);

    // Single-use: a replay of the same code fails.
    const reuse = await redeem(code, verifier);
    expect(reuse.status).toBe(400);
  });

  it('rejects redeem with a wrong verifier', async () => {
    const issueRes = await issue(
      { authorization: `Bearer ${bearer}` },
      pkceS256('right-verifier-xyz'),
    );
    const { code } = (await issueRes.json()) as { code: string };
    const r = await redeem(code, 'wrong-verifier-xyz');
    expect(r.status).toBe(400);
  });

  it('rejects a malformed code_challenge', async () => {
    const r = await issue({ authorization: `Bearer ${bearer}` }, 'too-short');
    expect(r.status).toBe(400);
  });
});
