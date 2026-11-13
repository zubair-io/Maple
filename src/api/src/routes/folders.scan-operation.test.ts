/**
 * The folder scan as an operation: registering a folder leaves a `folder_scan`
 * row for the worker tier, and the two awaited scan routes answer from the
 * row's outcome — a failure with its error, and a walk still going when the
 * wait runs out, or when the client goes away, with a 504 while the row
 * finishes in the background.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { withOperationsRunning } from '../job-runner/operation-runner.test-helpers.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { folderScanRoutes } from './folders-scan.ts';
import { foldersRoutes } from './folders.ts';

interface JobRow {
  id: string;
  kind: string;
  status: string;
  params: string;
}

let live: LiveTestDatabase;
let directory = '';
let savedRoots: string | undefined;

beforeEach(async () => {
  savedRoots = process.env.MAPLE_ROOTS;
  delete process.env.MAPLE_ROOTS;
  live = await createLiveTestDatabase();
  invalidateLibraryRoots();
  directory = await realpath(await mkdtemp(join(tmpdir(), 'maple-scan-operation-')));
});

afterEach(async () => {
  live.close();
  invalidateLibraryRoots();
  if (savedRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = savedRoots;
  await rm(directory, { recursive: true, force: true });
});

const app = () => new Elysia().use(fakeAuth({ role: 'owner' })).use(foldersRoutes);

const post = (url: string, body?: unknown) =>
  app().handle(
    new Request(`http://localhost${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const jobRows = () => live.db.query(`SELECT id, kind, status, params FROM jobs`).all() as JobRow[];

describe('folder scans run as operations', () => {
  it('registering a folder queues its scan for the worker tier', async () => {
    const res = await post('/api/folders', { path: directory });

    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const rows = jobRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'folder_scan', status: 'queued' });
    expect(JSON.parse(rows[0]!.params)).toEqual({ folderId: id });
  });

  /** The scan routes alone, with a wait of the test's own; no worker runs the row. */
  const scanWith =
    (timeoutMs: number, init: RequestInit = {}) =>
    (folderId: string) =>
      new Elysia()
        .use(fakeAuth({ role: 'owner' }))
        .use(folderScanRoutes({ timeoutMs, intervalMs: 5 }))
        .handle(
          new Request(`http://localhost/api/folders/${folderId}/scan`, { method: 'POST', ...init }),
        );

  it('answers 504 when the walk outlasts the wait, and leaves the row to finish', async () => {
    const folderId = insertFolder(live.db, { path: directory, slug: 'slow' });

    const res = await scanWith(30)(folderId);

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'The scan is still running and will finish in the background',
    });
    expect(jobRows()).toEqual([expect.objectContaining({ kind: 'folder_scan', status: 'queued' })]);
  });

  it('stops waiting as soon as the client goes away', async () => {
    const folderId = insertFolder(live.db, { path: directory, slug: 'abandoned' });
    const client = new AbortController();
    setTimeout(() => client.abort(), 30);
    const started = Date.now();

    const res = await scanWith(30_000, { signal: client.signal })(folderId);

    expect(res.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(jobRows()).toEqual([expect.objectContaining({ kind: 'folder_scan', status: 'queued' })]);
  });

  it('answers 500 with the row error when the walk fails', async () => {
    const folderId = insertFolder(live.db, { path: directory, slug: 'failing' });

    const res = await withOperationsRunning(() => post(`/api/folders/${folderId}/rescan`), {
      handlers: {
        folder_scan: {
          run: async () => {
            throw new Error('disk went away');
          },
        },
      },
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'disk went away' });
  });

  it('a later scan of the same folder runs again once the earlier one has finished', async () => {
    const folderId = insertFolder(live.db, { path: directory, slug: 'twice' });

    const first = await withOperationsRunning(() => post(`/api/folders/${folderId}/rescan`));
    const second = await withOperationsRunning(() => post(`/api/folders/${folderId}/rescan`));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(jobRows().map((row) => row.status)).toEqual(['done', 'done']);
  });
});
