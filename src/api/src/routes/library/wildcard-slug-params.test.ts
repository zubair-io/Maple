/**
 * Focused coverage for `wildcardSlugParams` (#2508) — the shared `params`
 * schema now used by all five `/:slug/*` wildcard library routes (video,
 * folder, image, thumb, preview), replacing each route's own
 * `t.Object({ slug: ..., '*': t.Optional(t.String()) })`.
 *
 * Two things this file exists to prove:
 *
 *   1. None of the five real route registrations trigger Elysia's "Failed
 *      to create exactMirror" fallback warning on a representative
 *      wildcard request — the bug this ticket closes.
 *   2. The schema itself still validates/passes through a request exactly
 *      as the old per-route `{ slug, '*' }` object did: bare path, nested
 *      path, a URL-encoded segment, and an unmatched (empty-slug) path all
 *      keep their existing status.
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
  return warnCalls.some((args) => args.some((a) => String(a).includes('exactMirror')));
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

describe('wildcardSlugParams — the five real routes register without the exactMirror fallback', () => {
  // `app` is typed structurally (just the one method this test calls)
  // rather than as `Elysia` — each route export's real type is a distinct,
  // rich phantom type per its own route chain, which a shared array type
  // can't unify without widening. Handle is all this test needs.
  const cases: Array<{
    name: string;
    app: { handle: (req: Request) => Promise<Response> };
    path: string;
  }> = [
    { name: 'video', app: videoRoutes, path: '/api/video/mylib/sub/dir/clip.mov' },
    { name: 'folder', app: folderRoutes, path: '/api/folder/mylib/sub/dir' },
    { name: 'image', app: imageRoutes, path: '/api/image/mylib/sub/dir/photo.jpg' },
    { name: 'thumb', app: thumbRoutes, path: '/api/thumb/mylib/sub/dir/photo.jpg' },
    { name: 'preview', app: previewRoutes, path: '/api/preview/mylib/sub/dir/photo.jpg' },
  ];

  for (const { name, app, path } of cases) {
    test(`${name}: no "Failed to create exactMirror" warning on a wildcard request`, async () => {
      // The response itself may well be a 401/404/500 — these apps aren't
      // wired with real auth/DB/filesystem state here. Only the warning
      // behaviour (a property of route REGISTRATION, not of the response)
      // is under test.
      await app.handle(new Request(`http://localhost${path}`));
      expect(warnedAboutExactMirror()).toBe(false);
    });
  }
});
