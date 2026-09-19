/**
 * Web-to-web LAN session handoff: an authenticated page on the public origin
 * mints a one-time code, and the page on the server's plain-HTTP LAN address
 * spends it for a session of its own.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787), so the counted refresh token is the one this test
 * caused rather than whatever a sibling suite left behind.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import type { ObjectId } from '../../src/db/object-id.ts';
import {
  lanHandoffIssueRoutes,
  lanHandoffRedeemRoutes,
} from '../../src/routes/auth-lan-handoff.ts';
import { signAccessToken } from '../../src/auth/tokens.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { seedUser } from '../helpers/sqlite-fixtures.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const app = new Elysia()
  .use(lanHandoffRedeemRoutes)
  // Mirror index.ts: wrap the self-gating issue route so its `requireAuth`
  // scoped-derive stays contained and doesn't gate the public redeem.
  .use(new Elysia().use(lanHandoffIssueRoutes));

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

const issue = (headers: Record<string, string>) =>
  app.handle(
    new Request('http://localhost/api/auth/lan-handoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    }),
  );

const redeem = (code: string, ip = '203.0.113.20') =>
  app.handle(
    new Request('http://localhost/api/auth/lan-handoff/redeem', {
      method: 'POST',
      // Distinct IP so these (rate-limited) redeems use their own bucket.
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ code }),
    }),
  );

describe('web-to-web-LAN session handoff', () => {
  it('POST /lan-handoff requires a bearer', async () => {
    const r = await issue({});
    expect(r.status).toBe(401);
  });

  it('issues a code (authed) and redeems it for a fresh session', async () => {
    const issueRes = await issue({ authorization: `Bearer ${bearer}` });
    expect(issueRes.status).toBe(200);
    const { code } = (await issueRes.json()) as { code: string };
    expect(typeof code).toBe('string');

    const redeemRes = await redeem(code);
    expect(redeemRes.status).toBe(200);
    const body = (await redeemRes.json()) as {
      access_token: string;
      refresh_token?: string;
      user: { id: string };
    };
    expect(typeof body.access_token).toBe('string');
    expect(body.user.id).toBe(userId.toHexString());
    // The refresh token rides ONLY in the cookie — never in the JSON body
    // (unlike the native-code redeem, which hands raw tokens to the app).
    expect(body.refresh_token).toBeUndefined();

    // The cookie must NOT be `Secure` — this route only ever answers on the
    // server's plain-HTTP LAN origin, and a Secure cookie would never be
    // sent back over that connection.
    const setCookie = redeemRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('maple_refresh=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie.toLowerCase()).not.toContain('secure');

    expect(refreshTokenCount()).toBe(1);

    // Single-use: a replay of the same code fails.
    const reuse = await redeem(code, '203.0.113.21');
    expect(reuse.status).toBe(400);
  });

  it('rejects an unknown code', async () => {
    const r = await redeem('no-such-code');
    expect(r.status).toBe(400);
  });
});
