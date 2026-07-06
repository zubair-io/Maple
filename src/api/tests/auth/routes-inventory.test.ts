/**
 * Route-inventory auth gate (#853).
 *
 * Every mounted route must have an explicit auth decision: it either rejects an
 * unauthenticated request with 401, or it is listed in `PUBLIC_ROUTES` below
 * with a reason. A route that is neither gated nor allowlisted fails this test
 * — which is what stops the "mounted a route outside requireAuth" class of bug
 * (the original unauthenticated-backup-routes P0) from silently reopening.
 *
 * **When this test fails:** a new route is serving unauthenticated traffic.
 * Either move it inside the `requireAuth` sub-app in `src/index.ts`, or, if it
 * is intentionally public, add it to `PUBLIC_ROUTES` with a one-line reason.
 *
 * Mongo-free: `requireAuth` short-circuits to 401 before the handler — and
 * before body validation (verified) — so gated routes 401 with no DB access.
 * Public routes are declared, not probed.
 */
import { describe, it, expect } from 'bun:test';
import { buildApp } from '../../src/index.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

const app = buildApp({ stageNames: [] });

// Intentionally-unauthenticated routes. Adding an entry here is a conscious
// decision to expose a route without a bearer — keep the reason in the comment.
const PUBLIC_ROUTES = new Set<string>([
  'OPTIONS /*', // CORS preflight
  'GET /api/health', // liveness probe (no user data)
  'GET /api/network/local-address', // LAN-address discovery (no user data) — see routes/network.ts
  'GET /api/auth/bootstrap', // claim-state probe (no user data)
  'POST /api/auth/dev-login', // dev-only; 404 unless MAPLE_DEV_AUTH=1
  'POST /api/auth/register/options', // passkey registration ceremony
  'POST /api/auth/register/verify',
  'POST /api/auth/login/options', // passkey login ceremony
  'POST /api/auth/login/verify',
  'POST /api/auth/refresh', // session bootstrap (rotates the httpOnly cookie)
  'POST /api/auth/logout',
  'POST /api/auth/native-code/redeem', // native PKCE redeem (#856): the app's FIRST
  // token grab, before it holds any bearer — gated by the one-time code + PKCE
  // verifier, not by auth. (The paired issue route, POST /api/auth/native-code,
  // IS authed and is correctly gated.)
  'POST /api/auth/lan-handoff/redeem', // web-to-web-LAN handoff redeem: the LAN
  // origin's FIRST token grab, gated by the one-time code, not by auth. (The
  // paired issue route, POST /api/auth/lan-handoff, IS authed.)
  'GET /api/geocode/reverse', // read-only Place metadata by lat/lon (no user data)
  'GET /docs', // Scalar API docs UI (client codegen source)
  'GET /openapi.json', // OpenAPI spec (client codegen source)
  'GET /*', // static UI (Angular SPA walks the user through sign-in)
]);

// Self-authenticating via a `?token=` query param on the WS handshake (browsers
// can't set Authorization on `new WebSocket()`). Not driveable as a normal HTTP
// request here; its own 401-on-missing-token check lives in the route.
const SELF_AUTH_WS = new Set<string>(['WS /api/events']);

// Replace `:param` segments with a dummy so the route pattern matches.
const probePath = (path: string): string => path.replace(/:[^/]+/g, 'x');

describe('every route has an explicit auth decision (#853)', () => {
  const routes = (
    (app as unknown as { routes?: { method: string; path: string }[] }).routes ?? []
  ).map((r) => ({
    method: String(r.method),
    path: String(r.path),
    key: `${String(r.method)} ${String(r.path)}`,
  }));

  it('exposes a non-trivial route table', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it('allowlists have no stale entries (every listed route is still mounted)', () => {
    const keys = new Set(routes.map((r) => r.key));
    const stale = [...PUBLIC_ROUTES, ...SELF_AUTH_WS].filter((k) => !keys.has(k));
    if (stale.length > 0) {
      throw new Error(
        `Allowlisted routes no longer mounted — remove them:\n  ${stale.join('\n  ')}`,
      );
    }
    expect(stale).toEqual([]);
  });

  it('every non-public route rejects an unauthenticated request with 401', async () => {
    const gated = routes.filter((r) => !PUBLIC_ROUTES.has(r.key) && !SELF_AUTH_WS.has(r.key));
    const offenders: string[] = [];
    for (const r of gated) {
      const res = await app.handle(
        new Request(`http://localhost${probePath(r.path)}`, {
          method: r.method,
          headers: { 'content-type': 'application/json' },
        }),
      );
      if (res.status !== 401) offenders.push(`${r.key} -> ${res.status}`);
    }
    if (offenders.length > 0) {
      throw new Error(
        'Routes serving unauthenticated traffic that are not in PUBLIC_ROUTES. Gate them ' +
          'behind requireAuth (move into the authedApi sub-app in src/index.ts), or add them ' +
          `to PUBLIC_ROUTES with a reason:\n  ${offenders.join('\n  ')}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
