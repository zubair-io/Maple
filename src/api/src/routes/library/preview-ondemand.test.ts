// On-demand previews against a saturated preview stage (#5433).
//
// The real route, the real `preview` stage handler and the real background
// gate, over a per-test SQLite catalogue and real files in a temp library. The
// two IPC directions between the API process and the worker child are wired
// back to back in-process: the renderer's interactive state goes straight into
// the gate, and the gate's `process.send` announcements go straight into the
// renderer.
//
// `generatePreview` is replaced (via `spyOn`, never `mock.module` — see
// #2032) by a renderer that writes a real file after a controllable delay and
// runs on a simulated CPU with as many slots as the gate admits, so a render
// that queues behind the stage shows up as latency.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from '../../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { ffiPool } from '../../ffi/ffi-pool.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import {
  ondemandPreviewCapacity,
  _resetOndemandPreviewsForTests,
  ondemandPreviews,
} from '../../indexer/ondemand-preview.ts';
import { isPreviewStageRenderMessage } from '../../indexer/preview-priority-protocol.ts';
import {
  _backgroundPreviewRendersRunning,
  _resetBackgroundPreviewGateForTests,
  setInteractivePreviewActive,
} from '../../workers/background-preview-gate.ts';
import { ObjectId, newObjectIdHex } from '../../db/object-id.ts';
import { registerLibrary, seedRouteAsset } from '../../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

const RENDER_MS = 120;

const previewerModule = await import('../../indexer/previewer.ts');
const { default: previewStage } = await import('../../workers/stages/preview.ts');
const { previewRoutes } = await import('./preview.ts');
const { Elysia } = await import('elysia');
const app = new Elysia().use(previewRoutes);

let live: LiveTestDatabase;
let tmpDir = '';
let libraryId = '';

/** Every render, in start order, by source filename. */
let renders: string[] = [];
/** The interactive state the gate was last told, and the renders that started under it. */
let interactiveActive = false;
let startedWhileInteractive: string[] = [];
/** Renders that may not finish until the test releases them. */
let held = new Map<string, PromiseWithResolvers<void>>();

/** FIFO simulated CPU, sized to what the gate admits. */
let cpuFree = 0;
const cpuQueue: Array<() => void> = [];
async function onCpu<T>(work: () => Promise<T>): Promise<T> {
  if (cpuFree > 0) cpuFree--;
  else await new Promise<void>((resolve) => cpuQueue.push(resolve));
  try {
    return await work();
  } finally {
    const next = cpuQueue.shift();
    if (next) next();
    else cpuFree++;
  }
}

async function fakeGeneratePreview(absPath: string, previewPath?: string): Promise<boolean> {
  if (!previewPath) throw new Error('Expected an explicit preview output path');
  const name = basename(absPath);
  renders.push(name);
  if (interactiveActive) startedWhileInteractive.push(name);
  await held.get(name)?.promise;
  await onCpu(() => Bun.sleep(RENDER_MS));
  await mkdir(join(previewPath, '..'), { recursive: true });
  await writeFile(previewPath, `preview-of-${name}`);
  return true;
}

let generatePreviewSpy: { mockRestore(): void } | null = null;
const originalSend = process.send;

beforeAll(() => {
  generatePreviewSpy = spyOn(previewerModule, 'generatePreview').mockImplementation(
    fakeGeneratePreview,
  );
});

afterAll(() => {
  generatePreviewSpy?.mockRestore();
  generatePreviewSpy = null;
});

beforeEach(async () => {
  live = await createLiveTestDatabase();
  tmpDir = await realpath(await mkdtemp(join(tmpdir(), 'maple-preview-ondemand-')));
  libraryId = registerLibrary(live.db, tmpDir, 'ondemandlib');
  renders = [];
  interactiveActive = false;
  startedWhileInteractive = [];
  held = new Map();
  cpuFree = ffiPool().poolSize();
  cpuQueue.length = 0;
  _resetOndemandPreviewsForTests();
  _resetBackgroundPreviewGateForTests();
  ondemandPreviews().attachWorker((message) => {
    interactiveActive = message.active;
    setInteractivePreviewActive(message.active);
  });
  process.send = ((message: unknown) => {
    if (isPreviewStageRenderMessage(message)) ondemandPreviews().onStageRender(message);
    return true;
  }) as typeof process.send;
});

afterEach(async () => {
  process.send = originalSend;
  ondemandPreviews().detachWorker();
  _resetBackgroundPreviewGateForTests();
  invalidateLibraryRoots();
  live.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

/** Index a source file the route can serve. */
async function seedSource(filename: string): Promise<void> {
  seedRouteAsset(live.db, {
    libraryId,
    path: '',
    filename,
    mapleId: newObjectIdHex(),
  });
  await writeFile(join(tmpDir, filename), 'source-bytes');
}

/** The document shape the stage handler reads, for a file at the library root. */
function stageDoc(filename: string) {
  return {
    _id: new ObjectId(),
    fileinfo: [
      {
        path: '',
        filename,
        library_id: new ObjectId(libraryId),
        deleted_at: null,
      },
    ],
  };
}

function runStageHandler(filename: string): Promise<unknown> {
  return previewStage.handler(stageDoc(filename) as never, {} as never);
}

function request(filename: string, signal?: AbortSignal): Promise<Response> {
  return app.handle(new Request(`http://localhost/preview/ondemandlib/${filename}`, { signal }));
}

async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(5);
  }
}

const previewFile = (filename: string): string =>
  join(tmpDir, '.maple', 'previews', `${filename}.avif`);

describe('on-demand previews take priority over the preview stage (#5433)', () => {
  it('serves a cold preview in about one render while the stage has a deep backlog', async () => {
    const backlog = Array.from({ length: 12 }, (_, i) => `bg-${i}.jpg`);
    for (const name of backlog) await writeFile(join(tmpDir, name), 'source-bytes');
    await seedSource('wanted.jpg');

    const stageRun = Promise.all(backlog.map(runStageHandler));
    const capacity = cpuFree;
    await until(() => _backgroundPreviewRendersRunning() === capacity);

    const t0 = performance.now();
    const res = await request('wanted.jpg');
    const elapsed = performance.now() - t0;

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('preview-of-wanted.jpg');
    // No stage render starts while it is pending (below), so it waits out at
    // most the in-flight one: about two renders, not the whole backlog.
    expect(elapsed).toBeLessThan(RENDER_MS * 5);
    expect(startedWhileInteractive).toEqual(['wanted.jpg']);

    await stageRun;
    for (const name of backlog) expect((await stat(previewFile(name))).size).toBeGreaterThan(0);
  });

  it('runs one render for concurrent requests of the same preview', async () => {
    await seedSource('same.jpg');
    const responses = await Promise.all([request('same.jpg'), request('same.jpg')]);
    for (const res of responses) expect(res.status).toBe(200);
    expect(renders.filter((name) => name === 'same.jpg')).toHaveLength(1);
  });

  it('waits for the stage render of the same preview instead of starting a second', async () => {
    await seedSource('shared.jpg');
    held.set('shared.jpg', Promise.withResolvers<void>());
    const stageRender = runStageHandler('shared.jpg');
    await until(() => renders.includes('shared.jpg'));

    const pending = request('shared.jpg');
    await Bun.sleep(RENDER_MS);
    held.get('shared.jpg')?.resolve();
    const res = await pending;
    await stageRender;

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('preview-of-shared.jpg');
    expect(renders.filter((name) => name === 'shared.jpg')).toHaveLength(1);
  });

  it('skips the render when the client disconnects before it starts', async () => {
    const blockers = Array.from({ length: ondemandPreviewCapacity() }, (_, i) => `busy-${i}.jpg`);
    for (const name of blockers) {
      await seedSource(name);
      held.set(name, Promise.withResolvers<void>());
    }
    await seedSource('abandoned.jpg');

    const busy = blockers.map((name) => request(name));
    await until(() => blockers.every((name) => renders.includes(name)));
    const controller = new AbortController();
    const abandoned = request('abandoned.jpg', controller.signal).catch(() => null);
    await Bun.sleep(20);
    controller.abort();
    for (const name of blockers) held.get(name)?.resolve();
    await Promise.all(busy);
    await abandoned;

    expect(renders).not.toContain('abandoned.jpg');
    expect(await stat(previewFile('abandoned.jpg')).catch(() => null)).toBeNull();
  });

  it('finishes and writes a render that had started when the client disconnected', async () => {
    await seedSource('started.jpg');
    held.set('started.jpg', Promise.withResolvers<void>());
    const controller = new AbortController();
    const pending = request('started.jpg', controller.signal).catch(() => null);
    await until(() => renders.includes('started.jpg'));
    controller.abort();
    held.get('started.jpg')?.resolve();
    await pending;
    await until(
      async () => ((await stat(previewFile('started.jpg')).catch(() => null))?.size ?? 0) > 0,
    );
  });
});
