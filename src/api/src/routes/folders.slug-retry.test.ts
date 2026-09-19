/**
 * Tests for the slug-collision retry loop in POST /api/folders.
 *
 * Simulates the race: two concurrent POSTs that both read the same taken-set
 * and mint the same slug. The unique `folders_slug_unique` index catches the
 * collision and the route retries with a suffixed slug.
 *
 * We test this by:
 *   1. Pre-inserting a folder with the slug that POST /api/folders would mint.
 *   2. Issuing the POST — it must succeed (201) with a deduplicated slug,
 *      not fail with 500 on the constraint violation.
 *
 * The handler reaches `sqliteDb()` with no override, so each test installs its
 * own database as the process-wide handle for the block.
 */

import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdir, rm } from 'node:fs/promises';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { foldersRoutes } from './folders.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';

describe('POST /api/folders — slug collision retry', () => {
  let live: LiveTestDatabase;
  let tmpDir = '';

  beforeEach(async () => {
    // `folders_slug_unique` is part of the schema the harness migrates in, so
    // the constraint the retry loop recovers from is present by construction
    // rather than created by this file.
    live = await createLiveTestDatabase();
    // Create a real temporary directory so validateRoot passes.
    tmpDir = `/tmp/maple-slug-retry-test-${process.pid}`;
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    live.close();
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      tmpDir = '';
    }
  });

  it('succeeds with a deduplicated slug when the base slug is already taken', async () => {
    // Pre-insert a folder with the slug that POST would mint for "My Library"
    // (slugify("My Library") → "my-library"). This simulates a concurrent insert
    // claiming the slug just before our request reaches the DB.
    insertFolder(live.db, { path: '/other/path', slug: 'my-library' });

    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const res = await app.handle(
      new Request('http://localhost/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: tmpDir, label: 'My Library' }),
      }),
    );

    // Must succeed — not 500 on E11000.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string; path: string; label: string };
    // The retry loop must have minted a suffixed slug.
    expect(body.slug).toBe('my-library-2');
    expect(body.path).toBe(tmpDir);
    expect(body.label).toBe('My Library');
  });

  it('two concurrent POSTs racing on the same base slug both succeed with distinct slugs', async () => {
    // Unlike the pre-inserted-collision test above (where the taken-set read
    // already sees the colliding slug), this drives a genuine TOCTOU race:
    // two concurrent POSTs for the SAME label both start from an empty
    // taken-set, both mint the same base slug, and only one insertOne can
    // win the unique index. The loser's retry loop must recover with the
    // widened in-memory taken-set (not a re-query) and succeed with a
    // suffixed slug — not surface a 500.
    // Nested INSIDE tmpDir, not siblings of it, so afterEach's recursive
    // rm(tmpDir) always reclaims them — a sibling would leak under /tmp on
    // any run where an assertion below throws before the cleanup line.
    const tmpDirA = `${tmpDir}/a`;
    const tmpDirB = `${tmpDir}/b`;
    await mkdir(tmpDirA, { recursive: true });
    await mkdir(tmpDirB, { recursive: true });

    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const post = (path: string) =>
      app.handle(
        new Request('http://localhost/api/folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, label: 'Concurrent Library' }),
        }),
      );

    const [resA, resB] = await Promise.all([post(tmpDirA), post(tmpDirB)]);

    // Neither request may fail with a 500 on the collision.
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    const bodyA = (await resA.json()) as { slug: string; path: string };
    const bodyB = (await resB.json()) as { slug: string; path: string };
    expect(bodyA.slug).not.toBe(bodyB.slug);
    expect([bodyA.slug, bodyB.slug].sort()).toEqual(['concurrent-library', 'concurrent-library-2']);
  });

  it('GET /api/folders returns slug in the payload (client addresses libraries by slug)', async () => {
    insertFolder(live.db, { path: tmpDir, slug: 'library' });

    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const res = await app.handle(new Request('http://localhost/api/folders'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; slug?: string }>;
    // Regression: without `slug` in the payload the web client falls back to
    // f.id (the raw 24-character id) and addresses an invalid /api/folder/<id>.
    const row = body.find((f) => f.slug === 'library');
    expect(row).toBeDefined();
    expect(row!.slug).toBe('library');
  });
});
