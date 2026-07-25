// browseRoots() memoisation (#2219).
//
// `resolveJailedFile` calls browseRoots() on every /api/fs/thumb request, so a
// grid full of thumbnails used to pay one realpath() syscall per configured
// root per image — re-deriving a value that is pinned to a process-lifetime env
// var. The memo is keyed on the raw MAPLE_ROOTS string so tests (and any future
// runtime repoint) still observe a change.

import { describe, expect, it, afterEach } from 'bun:test';
import { mkdtemp, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { browseRoots } from './browse.ts';

const PRIOR_MAPLE_ROOTS = process.env.MAPLE_ROOTS;

afterEach(() => {
  if (PRIOR_MAPLE_ROOTS === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = PRIOR_MAPLE_ROOTS;
});

describe('browseRoots memoisation', () => {
  // MUST be the first test in this file: it covers the cold-memo path with
  // MAPLE_ROOTS unset, where `browseRootsMemo?.env === env` would compare
  // `undefined === undefined`, report a hit on an empty memo, and throw. Any
  // test above this one warms the memo and hides that.
  it('defaults to / on the very first call with MAPLE_ROOTS unset', async () => {
    delete process.env.MAPLE_ROOTS;
    expect(await browseRoots()).toEqual(['/']);
  });

  it('returns the identical array for repeat calls with an unchanged env', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'maple-roots-')));
    process.env.MAPLE_ROOTS = root;

    const first = await browseRoots();
    const second = await browseRoots();

    expect(first).toEqual([root]);
    // Same reference — proof the second call did no work at all, not merely
    // that it produced an equal value.
    expect(second).toBe(first);
  });

  // The burst this memo exists for (a grid opening) all arrives before the first
  // resolve settles. Caching only the settled value would let each concurrent
  // caller run its own `realpath` and hand back a DIFFERENT array; sharing the
  // in-flight promise makes them one attempt with one result object.
  it('coalesces concurrent callers onto a single resolve', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'maple-roots-conc-')));
    process.env.MAPLE_ROOTS = root;

    const [a, b, c] = await Promise.all([browseRoots(), browseRoots(), browseRoots()]);

    expect(a).toEqual([root]);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('re-resolves when MAPLE_ROOTS changes', async () => {
    const a = await realpath(await mkdtemp(path.join(tmpdir(), 'maple-roots-a-')));
    const b = await realpath(await mkdtemp(path.join(tmpdir(), 'maple-roots-b-')));

    process.env.MAPLE_ROOTS = a;
    expect(await browseRoots()).toEqual([a]);

    process.env.MAPLE_ROOTS = b;
    expect(await browseRoots()).toEqual([b]);
  });

  it('still symlink-resolves each root, and defaults to / when unset', async () => {
    const real = await realpath(await mkdtemp(path.join(tmpdir(), 'maple-roots-real-')));
    const linkParent = await realpath(await mkdtemp(path.join(tmpdir(), 'maple-roots-link-')));
    const link = path.join(linkParent, 'via-link');
    await symlink(real, link);

    process.env.MAPLE_ROOTS = link;
    expect(await browseRoots()).toEqual([real]);

    delete process.env.MAPLE_ROOTS;
    expect(await browseRoots()).toEqual(['/']);
  });
});
