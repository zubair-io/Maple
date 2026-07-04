/**
 * routes/imports.ts integration tests. Real Mongo + real temp dirs
 * (skip-pass when Mongo is unreachable).
 *
 * Covers: scan happy path, jail rejection, create (happy + label-traversal
 * rejection + unknown library), list/get/cancel, and bad-ObjectId 400s.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { importsRoutes } from './imports.ts';
import { getDb, isDbConnected } from '../db/client.ts';

let db: Db | null = null;
let mongoReachable = false;
const app = new Elysia().use(importsRoutes);
let sourceRoot: string;
let libraryId: ObjectId;

async function put(rel: string, mtimeUtc: string): Promise<void> {
  const abs = path.join(sourceRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `c-${rel}`);
  const when = new Date(mtimeUtc);
  await fs.utimes(abs, when, when);
}

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-routes-'));
  sourceRoot = await realpath(tmp);
  // Jail the whole tmpdir so the source folder resolves inside MAPLE_ROOTS.
  process.env.MAPLE_ROOTS = await realpath(os.tmpdir());
  await put('IMG_0001.dng', '2024-03-09T12:00:00Z');
  await put('IMG_0001.xmp', '2024-03-09T12:00:00Z');
  await put('clip.mov', '2024-03-20T00:00:00Z');

  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
  }
});

beforeEach(async () => {
  if (!mongoReachable || !db) return;
  await db.collection('imports').deleteMany({});
  await db.collection('folders').deleteMany({});
  libraryId = new ObjectId();
  await db.collection('folders').insertOne({
    _id: libraryId,
    path: '/srv/lib',
    label: 'Lib',
    last_scan: null,
    file_count: 0,
    created_at: '2026-05-31T00:00:00Z',
  } as never);
});

afterAll(async () => {
  await fs.rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
});

async function post(url: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/imports/scan', () => {
  it('returns mtime-bucketed groups', async () => {
    const res = await post('/api/imports/scan', { source_root: sourceRoot });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { buckets: { key: string }[] };
    expect(body.buckets.map((b) => b.key)).toEqual(['2024/03']);
  });

  it('rejects a path outside MAPLE_ROOTS', async () => {
    const res = await post('/api/imports/scan', { source_root: '/etc' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid library_id', async () => {
    const res = await post('/api/imports/scan', {
      source_root: sourceRoot,
      library_id: 'not-an-id',
    });
    expect(res.status).toBe(400);
  });

  it('reports a nearby-asset match when library_id is given', async () => {
    if (!mongoReachable || !db) return;
    await db.collection('assets').deleteMany({});
    // IMG_0001.dng's mtime is 2024-03-09T12:00:00Z (no real EXIF in its
    // plain-text test content, so capturedAtMs falls back to mtime) — an
    // asset captured 10 minutes later, in the same library, should match.
    await db.collection('assets').insertOne({
      exif: { captured_at: '2024-03-09T12:10:00.000Z' },
      fileinfo: [{ path: '2024/Reunion', filename: 'a.dng', library_id: libraryId }],
    } as never);

    const res = await post('/api/imports/scan', {
      source_root: sourceRoot,
      library_id: libraryId.toHexString(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      buckets: {
        key: string;
        defaultDest: string;
        nearbyMatchCount: number;
        nearbyMatchFolders: string[];
      }[];
    };
    const bucket = body.buckets.find((b) => b.key === '2024/03')!;
    // IMG_0001.dng matches AND its sidecar IMG_0001.xmp follows it, so this
    // is 2, not 1 — a sidecar always lands wherever its parent lands.
    expect(bucket.nearbyMatchCount).toBe(2);
    expect(bucket.nearbyMatchFolders).toEqual(['2024/Reunion']);
    // defaultDest is unaffected by the nearby match — it's the fallback for
    // files that DON'T match.
    expect(bucket.defaultDest).toBe(`2024/misc/${path.basename(sourceRoot)}`);
  });
});

describe('POST /api/imports', () => {
  it('creates a pending import with resolved destinations', async () => {
    if (!mongoReachable) return;
    const res = await post('/api/imports', {
      source_root: sourceRoot,
      library_id: libraryId.toHexString(),
      labels: { '2024/03': 'Spring' },
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const getRes = await app.handle(new Request(`http://localhost/api/imports/${id}`));
    const doc = (await getRes.json()) as {
      status: string;
      files: { dest: string }[];
    };
    expect(doc.status).toBe('pending');
    expect(doc.files.some((f) => f.dest === '2024/Spring/IMG_0001.dng')).toBe(true);
  });

  it('auto import queues immediately with no files and scan_pending=true', async () => {
    if (!mongoReachable) return;
    const res = await post('/api/imports', {
      source_root: sourceRoot,
      library_id: libraryId.toHexString(),
      auto: true,
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const getRes = await app.handle(new Request(`http://localhost/api/imports/${id}`));
    const doc = (await getRes.json()) as {
      status: string;
      scan_pending: boolean;
      files: unknown[];
      progress: { total: number };
    };
    // Deferred to the worker: pending, no files yet, scan flagged.
    expect(doc.status).toBe('pending');
    expect(doc.scan_pending).toBe(true);
    expect(doc.files).toHaveLength(0);
    expect(doc.progress.total).toBe(0);
  });

  it('rejects a traversal bucket label server-side', async () => {
    if (!mongoReachable) return;
    const res = await post('/api/imports', {
      source_root: sourceRoot,
      library_id: libraryId.toHexString(),
      labels: { '2024/03': '../escape' },
    });
    expect(res.status).toBe(400);
  });

  it('404s an unknown library', async () => {
    if (!mongoReachable) return;
    const res = await post('/api/imports', {
      source_root: sourceRoot,
      library_id: new ObjectId().toHexString(),
    });
    expect(res.status).toBe(404);
  });

  it('400s an invalid library_id', async () => {
    if (!mongoReachable) return;
    const res = await post('/api/imports', {
      source_root: sourceRoot,
      library_id: 'not-an-id',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a source that is the target library itself', async () => {
    if (!mongoReachable) return;
    // Register a library rooted at the source folder itself, then try to
    // import that same folder into it.
    const overlapId = new ObjectId();
    await db!.collection('folders').insertOne({
      _id: overlapId,
      path: sourceRoot,
      label: 'Same',
      last_scan: null,
      file_count: 0,
      created_at: '2026-05-31T00:00:00Z',
    } as never);
    const res = await post('/api/imports', {
      source_root: sourceRoot,
      library_id: overlapId.toHexString(),
    });
    expect(res.status).toBe(400);
  });

  it('allows a source that is a PARENT of the target library', async () => {
    if (!mongoReachable) return;
    // Library lives in a subfolder of the source. Importing the parent is
    // fine — the library's own files dedup-skip; this must NOT be blocked
    // (regression: a parent like `/` was wrongly rejected).
    const libPath = `${sourceRoot}/Library`;
    await fs.mkdir(libPath, { recursive: true }); // exists so realpath resolves it
    const childId = new ObjectId();
    await db!.collection('folders').insertOne({
      _id: childId,
      path: libPath, // inside the source
      label: 'Child',
      last_scan: null,
      file_count: 0,
      created_at: '2026-05-31T00:00:00Z',
    } as never);
    const res = await post('/api/imports', {
      source_root: sourceRoot,
      library_id: childId.toHexString(),
    });
    expect(res.status).toBe(201);
  });

  it('rejects a source that overlaps a library registered via a symlink', async () => {
    if (!mongoReachable) return;
    // The library is registered at a symlinked path; the source resolves to
    // the symlink's real target. Only realpath-resolving the library path
    // catches this overlap.
    const linkPath = `${sourceRoot}-libline`;
    await fs.symlink(sourceRoot, linkPath, 'dir').catch(() => {});
    const symId = new ObjectId();
    await db!.collection('folders').insertOne({
      _id: symId,
      path: linkPath, // a symlink → sourceRoot, not the canonical path
      label: 'Linked',
      last_scan: null,
      file_count: 0,
      created_at: '2026-05-31T00:00:00Z',
    } as never);
    const res = await post('/api/imports', {
      source_root: sourceRoot,
      library_id: symId.toHexString(),
    });
    await fs.rm(linkPath, { force: true }).catch(() => {});
    expect(res.status).toBe(400);
  });
});

describe('GET/cancel lifecycle', () => {
  it('lists, gets, and cancels', async () => {
    if (!mongoReachable) return;
    const created = await post('/api/imports', {
      source_root: sourceRoot,
      library_id: libraryId.toHexString(),
    });
    const { id } = (await created.json()) as { id: string };

    const list = await app.handle(new Request('http://localhost/api/imports?status=pending'));
    const listBody = (await list.json()) as {
      imports: { id: string; files?: unknown }[];
    };
    const summary = listBody.imports.find((i) => i.id === id);
    expect(summary).toBeDefined();
    // List is a summary — it must NOT carry the per-file array.
    expect('files' in summary!).toBe(false);

    // ?summary=1 on the detail route is likewise file-free; the plain detail
    // route still includes files.
    const polled = await app.handle(new Request(`http://localhost/api/imports/${id}?summary=1`));
    expect('files' in ((await polled.json()) as object)).toBe(false);
    const detail = await app.handle(new Request(`http://localhost/api/imports/${id}`));
    expect('files' in ((await detail.json()) as object)).toBe(true);

    const cancel = await post(`/api/imports/${id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { ok: boolean }).ok).toBe(true);

    const after = await app.handle(new Request(`http://localhost/api/imports/${id}`));
    expect(((await after.json()) as { cancel_requested: boolean }).cancel_requested).toBe(true);
  });

  it('400s a bad import id', async () => {
    const res = await app.handle(new Request('http://localhost/api/imports/not-an-id'));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/imports/:id/retry (#795)', () => {
  it('re-queues a failed import and refuses a clean one', async () => {
    if (!mongoReachable) return;
    const repo = await import('../imports/repo.ts');

    // A failed import with one failed file.
    const created = await repo.createImport({
      source_root: '/srv/in',
      library_id: libraryId,
      library_root: '/srv/lib',
      files: [
        {
          src: '/srv/in/bad.dng',
          dest: '2024/03/bad.dng',
          size: 1,
          mtime: 0,
          kind: 'image',
          state: 'failed',
          error: 'unsafe filename',
        },
      ],
    });
    await repo.failImport(created._id, 'a file failed');

    const retry = await post(`/api/imports/${created._id.toHexString()}/retry`, {});
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { ok: boolean }).ok).toBe(true);

    const after = await app.handle(
      new Request(`http://localhost/api/imports/${created._id.toHexString()}`),
    );
    const body = (await after.json()) as {
      status: string;
      error: string | null;
      files: { state: string }[];
    };
    expect(body.status).toBe('pending');
    expect(body.error).toBeNull();
    expect(body.files[0].state).toBe('pending');

    // A clean done import is NOT retryable → 409.
    const clean = await repo.createImport({
      source_root: '/srv/in',
      library_id: libraryId,
      library_root: '/srv/lib',
      files: [
        {
          src: '/srv/in/a.dng',
          dest: '2024/03/a.dng',
          size: 1,
          mtime: 0,
          kind: 'image',
          state: 'pending',
          error: null,
        },
      ],
    });
    await repo.completeImport(clean._id, { copied: 1, skipped: 0, failed: 0 });
    const refused = await post(`/api/imports/${clean._id.toHexString()}/retry`, {});
    expect(refused.status).toBe(409);
  });

  it('400s a bad import id on retry', async () => {
    const res = await post('/api/imports/not-an-id/retry', {});
    expect(res.status).toBe(400);
  });
});
