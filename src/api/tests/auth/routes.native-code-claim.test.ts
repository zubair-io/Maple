/**
 * POST /api/auth/native-code/claim (#3063) — device-flow-style completion for
 * the native sign-in ceremony. Chromium blocks the web app's script-initiated
 * maple-app:// redirect when the browser was already signed in (no user
 * gesture), so the native app polls this endpoint with its private PKCE
 * verifier + state instead of waiting on a redirect that may never launch.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787), so the pending-code row a claim consumes is read back
 * from the same database the route wrote it to.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import type { ObjectId } from 'mongodb';
import { nativeCodeIssueRoutes, nativeCodeClaimRoutes } from '../../src/routes/auth-native-code.ts';
import { signAccessToken } from '../../src/auth/tokens.ts';
import { pkceS256 } from '../../src/auth/native_code_store.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { seedUser } from '../helpers/sqlite-fixtures.ts';

const JWT_SECRET = 'x'.repeat(32);
process.env.MAPLE_JWT_SECRET = JWT_SECRET;

const app = new Elysia()
  .use(nativeCodeClaimRoutes)
  // Mirror index.ts: wrap the self-gating issue route so its `requireAuth`
  // scoped-derive stays contained and doesn't gate the public claim.
  .use(new Elysia().use(nativeCodeIssueRoutes));

let live: LiveTestDatabase;
let userId: ObjectId;
let bearer: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  userId = seedUser(live.db, { email: 'owner@maple.local', role: 'owner' });
  bearer = await signAccessToken(
    { file_access: true, sub: userId.toHexString(), email: 'owner@maple.local', role: 'owner' },
    JWT_SECRET,
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

const issue = (challenge: string, state: string) =>
  app.handle(
    new Request('http://localhost/api/auth/native-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ code_challenge: challenge, state }),
    }),
  );

const claim = (state: string, verifier: string, ip = '203.0.113.77') =>
  app.handle(
    new Request('http://localhost/api/auth/native-code/claim', {
      method: 'POST',
      // Distinct IP so these (rate-limited) claims use their own bucket.
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ state, code_verifier: verifier }),
    }),
  );

describe('native code claim (#3063)', () => {
  it('404s while nothing is pending, then claims once the web app mints', async () => {
    const verifier = 'poll-verifier-abcdefghijklmnopqrstuvwxyz-0123456789';
    const state = 'state-poll-1234';

    // App polls before the browser session mints anything → pending.
    const early = await claim(state, verifier);
    expect(early.status).toBe(404);

    // Signed-in web app mints the code (the #2964 bootstrap path).
    const issued = await issue(pkceS256(verifier), state);
    expect(issued.status).toBe(200);

    // Next poll completes the ceremony with the same payload as /redeem.
    const r = await claim(state, verifier);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      access_token: string;
      refresh_token: string;
      user: { id: string };
      state: string;
    };
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.user.id).toBe(userId.toHexString());
    expect(body.state).toBe(state);

    // Device-scoped refresh token minted for the claim.
    expect(refreshTokenCount()).toBe(1);

    // Single-use: the row is consumed — a replayed claim fails.
    const replay = await claim(state, verifier);
    expect(replay.status).toBe(404);
  });

  it('rejects a claim whose verifier does not hash to the stored challenge', async () => {
    await issue(pkceS256('right-verifier-1234567890-abcdefghijklmnopqrs'), 'state-poll-wrongv');
    const r = await claim('state-poll-wrongv', 'wrong-verifier-1234567890-abcdefghijklmnopqrs');
    expect(r.status).toBe(404);
  });

  it('rejects a claim whose state does not match', async () => {
    const verifier = 'poll-verifier-state-mismatch1-abcdefghijklmnop';
    await issue(pkceS256(verifier), 'state-poll-a');
    const r = await claim('state-poll-b', verifier);
    expect(r.status).toBe(404);
  });

  it('400s malformed input before doing any hashing work (public route)', async () => {
    // Verifier outside RFC 7636 shape (too short / bad charset) and oversized
    // state are refused up front — they can never match a real ceremony.
    expect((await claim('state-shape-ok', 'too-short')).status).toBe(400);
    expect((await claim('state-shape-ok', 'bad+chars/'.repeat(6))).status).toBe(400);
    expect(
      (await claim('x'.repeat(257), 'ok-verifier-abcdefghijklmnopqrstuvwxyz-01234')).status,
    ).toBe(400);
    expect((await claim('short', 'ok-verifier-abcdefghijklmnopqrstuvwxyz-01234')).status).toBe(400);
  });

  it('consumes the row on claim, so the redirect-delivered code is dead afterwards', async () => {
    const verifier = 'poll-verifier-exclusive-12345-abcdefghijklmnop';
    const state = 'state-poll-exclusive';
    await issue(pkceS256(verifier), state);

    const claimed = await claim(state, verifier);
    expect(claimed.status).toBe(200);

    const row = live.db
      .query(`SELECT consumed_at FROM native_auth_codes WHERE state = ?`)
      .get(state) as { consumed_at: string | null } | null;
    expect(row?.consumed_at).not.toBeNull();
  });

  it('rate limits polling per IP without starving a fresh ceremony', async () => {
    // The polling bucket allows a 2s cadence for minutes — 60/min. Exhaust it.
    const results: number[] = [];
    for (let i = 0; i < 61; i++) {
      const r = await claim(
        'state-rl-abcdef',
        'rl-verifier-abcdefghijklmnopqrstuvwxyz-01234567',
        '203.0.113.99',
      );
      results.push(r.status);
    }
    expect(results.slice(0, 60).every((s) => s === 404)).toBe(true);
    expect(results[60]).toBe(429);
  });
});
