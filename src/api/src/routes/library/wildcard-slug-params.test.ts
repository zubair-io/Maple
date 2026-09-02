/**
 * Focused coverage for `wildcardSlugParams` (#2508) — the shared `params`
 * schema now used by all five `/:slug/*` wildcard library routes (video,
 * folder, image, thumb, preview), replacing each route's own
 * `t.Object({ slug: ..., '*': t.Optional(t.String()) })`.
 *
 * Two things this file exists to prove:
 *
 *   1. `wildcardSlugParams()` itself never triggers Elysia's "Failed to
 *      create exactMirror" fallback warning — the bug this ticket closes —
 *      checked against a fresh `Elysia` instance per test so the result
 *      can't be hidden by another test's compile (see the second describe
 *      block below for why a live check can't do this for the five real
 *      routes' shared, cross-file-reused singletons).
 *   2. The schema itself still validates/passes through a request exactly
 *      as the old per-route `{ slug, '*' }` object did: bare path, nested
 *      path, a URL-encoded segment, and an unmatched (empty-slug) path all
 *      keep their existing status.
 *
 * A third thing, in the second describe block below: that each of the five
 * real routes is actually wired to `wildcardSlugParams()`, not a hand-rolled
 * duplicate that could reintroduce the bug independently of the schema.
 *
 * Each route's own test file (`video.test.ts`, `library/folder.test.ts`,
 * etc.) still owns the FULL behaviour contract for that route — auth,
 * missing-asset 404s, unsupported-extension 415s, traversal rejection, and
 * so on. This file is scoped to what's specific to the shared schema, not a
 * re-test of every route's whole contract.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { wildcardSlugParams } from './shared.ts';
import { videoRoutes } from '../video.ts';
import { folderRoutes } from './folder.ts';
import { imageRoutes } from './image.ts';
import { thumbRoutes } from './thumb.ts';
import { previewRoutes } from './preview.ts';

let warnCalls: unknown[][];
let originalWarn: typeof console.warn;

beforeEach(() => {
  warnCalls = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
});

afterEach(() => {
  console.warn = originalWarn;
});

/** True if any captured `console.warn` call mentions the exactMirror
 * fallback — the exact string Elysia logs (`schema.js`'s `console.warn`
 * calls), so a real regression is caught even if the message text shifts
 * slightly upstream (case/wording), while an unrelated warning elsewhere in
 * a route's own logic (there is none in these five, but belt-and-suspenders)
 * doesn't produce a false pass. */
function warnedAboutExactMirror(): boolean {
  return warnCalls.some((args) =>
    args.some((a) => String(a).toLowerCase().includes('exactmirror')),
  );
}

// A minimal stand-in route exercising ONLY the schema, not the real
// handlers' auth/DB/filesystem side effects. No explicit return type — an
// Elysia app's real type is a rich, per-route-chain phantom type that a
// widened `Elysia` annotation can't structurally accept.
function schemaOnlyTestApp() {
  return new Elysia().get(
    '/api/test/:slug/*',
    ({ params }) => ({
      slug: params.slug,
      wildcard: (params as Record<string, string>)['*'] ?? '',
    }),
    { params: wildcardSlugParams() },
  );
}

describe('wildcardSlugParams — schema behaviour', () => {
  test('a nested wildcard path is captured, and does not warn about exactMirror', async () => {
    const res = await schemaOnlyTestApp().handle(
      new Request('http://localhost/api/test/mylib/sub/dir/photo.jpg'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: 'mylib', wildcard: 'sub/dir/photo.jpg' });
    expect(warnedAboutExactMirror()).toBe(false);
  });

  test('a bare slug (no wildcard segment) still validates, with an empty wildcard', async () => {
    const res = await schemaOnlyTestApp().handle(new Request('http://localhost/api/test/mylib/'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: 'mylib', wildcard: '' });
  });

  test("a URL-encoded segment survives untouched (decoding is parseWildcardSegments' job, per-route)", async () => {
    const res = await schemaOnlyTestApp().handle(
      new Request('http://localhost/api/test/mylib/sub%20dir/a%23b.jpg'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: 'mylib', wildcard: 'sub%20dir/a%23b.jpg' });
  });

  test('an empty slug segment does not match the route (unchanged: 404, not a validation error)', async () => {
    const res = await schemaOnlyTestApp().handle(new Request('http://localhost/api/test//sub/dir'));
    expect(res.status).toBe(404);
  });
});

/**
 * Proves each real route is actually WIRED to the shared, fixed schema —
 * not that the schema itself is warning-free (the "schema behaviour" block
 * above already owns that, with a fresh `Elysia` instance per test).
 *
 * This deliberately does NOT trigger the routes and inspect `console.warn`
 * the way the block above does. `videoRoutes`, `folderRoutes`, etc. are
 * module-singleton `Elysia` instances that this file shares with each
 * route's OWN dedicated test file (`video.test.ts`, `library/folder.test.ts`,
 * ...) — bun collects and runs every test file in one process, and Elysia
 * memoizes a route's compiled params validator on first `.handle()` call
 * (confirmed by direct experiment: a second `.handle()` on the same route
 * does not recompile or re-warn). Whichever test file's `.handle()` call
 * runs first — by file path, alphabetically, across the whole suite — wins
 * that compile, using ITS OWN (real, uninstrumented) `console.warn`. Proven
 * with a throwaway regression (temporarily reintroducing the old buggy
 * `'*': t.Optional(t.String())` schema and running the full `src/routes`
 * suite): the warning was only caught here for `video` — `folder`, `image`,
 * `thumb`, and `preview` all sort alphabetically ahead of
 * `wildcard-slug-params.test.ts` and had already warmed (and silently
 * absorbed the warning via) their own dedicated test files by the time this
 * file's `beforeEach` spy existed. A `.handle()`-based check here would
 * have caught only 1 of 5 real regressions.
 *
 * Comparing each route's actual registered `params` hook against a fresh
 * `wildcardSlugParams()` call sidesteps the whole ordering hazard: it's a
 * plain structural read, not a side effect that depends on being first.
 */
describe('wildcardSlugParams — the five real routes are wired to the shared schema', () => {
  // `app` is typed structurally (just the one property this test reads)
  // rather than as `Elysia` — each route export's real type is a distinct,
  // rich phantom type per its own route chain, which a shared array type
  // can't unify without widening.
  const cases: Array<{
    name: string;
    app: { routes: Array<{ path: string; hooks?: { params?: unknown } }> };
    path: string;
  }> = [
    { name: 'video', app: videoRoutes, path: '/api/video/:slug/*' },
    { name: 'folder', app: folderRoutes, path: '/folder/:slug/*' },
    { name: 'image', app: imageRoutes, path: '/image/:slug/*' },
    { name: 'thumb', app: thumbRoutes, path: '/thumb/:slug/*' },
    { name: 'preview', app: previewRoutes, path: '/preview/:slug/*' },
  ];

  for (const { name, app, path } of cases) {
    test(`${name}: the wildcard route's params hook is wildcardSlugParams()`, () => {
      const route = app.routes.find((r) => r.path === path);
      expect(route).toBeDefined();
      expect(route?.hooks?.params).toEqual(wildcardSlugParams());
    });
  }
});
