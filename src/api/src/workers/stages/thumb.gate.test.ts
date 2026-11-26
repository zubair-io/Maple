// Which thumb renders take a background-gate slot (#6020).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from '../../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ffiPool } from '../../ffi/ffi-pool.ts';
import { DecodeMemoryBudgetError } from '../../ffi/decode-memory-budget.ts';
import { UnsupportedCameraError } from '../../ffi/unsupported-camera.ts';
import { resolveThumbPath } from '../../fs/xmp.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { NoVideoStreamError } from '../../thumbs/source-failure.ts';
import * as videoPoster from '../../thumbs/video-poster.ts';
import {
  _backgroundRendersRunning,
  _resetBackgroundRenderGateForTests,
  runBackgroundRender,
  setInteractivePreviewActive,
} from '../background-render-gate.ts';
import { ObjectId } from '../../db/object-id.ts';
import { registerLibrary } from '../../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

const thumbnailer = await import('../../indexer/thumbnailer.ts');
const { default: thumbStage } = await import('./thumb.ts');

let live: LiveTestDatabase;
let tmpDir = '';
let libraryId = '';
let generated: string[] = [];
let generateImpl: (absPath: string, thumbPath: string) => Promise<boolean>;
const spies: Array<{ mockRestore(): void }> = [];

const writeThumb = async (_absPath: string, thumbPath: string): Promise<boolean> => {
  await mkdir(dirname(thumbPath), { recursive: true });
  await writeFile(thumbPath, 'thumb');
  return true;
};

beforeAll(() => {
  spies.push(
    spyOn(thumbnailer, 'generateThumb').mockImplementation(async (absPath, thumbPath) => {
      generated.push(absPath.slice(absPath.lastIndexOf('/') + 1));
      return generateImpl(absPath, thumbPath ?? resolveThumbPath(absPath));
    }),
    spyOn(videoPoster, 'ffmpegBinary').mockResolvedValue('/usr/bin/true'),
  );
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

beforeEach(async () => {
  live = await createLiveTestDatabase();
  tmpDir = await realpath(await mkdtemp(join(tmpdir(), 'maple-thumb-gate-')));
  libraryId = registerLibrary(live.db, tmpDir, 'gatelib');
  generated = [];
  generateImpl = writeThumb;
  _resetBackgroundRenderGateForTests();
});

afterEach(async () => {
  setInteractivePreviewActive(false);
  _resetBackgroundRenderGateForTests();
  invalidateLibraryRoots();
  live.close();
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

async function runStage(filename: string, withFreshThumb = false): Promise<unknown> {
  await writeFile(join(tmpDir, filename), 'source-bytes');
  if (withFreshThumb) await writeThumb('', resolveThumbPath(join(tmpDir, filename)));
  const doc = {
    _id: new ObjectId(),
    fileinfo: [{ path: '', filename, library_id: new ObjectId(libraryId), deleted_at: null }],
  };
  return thumbStage.handler(doc as never, {} as never);
}

async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([work.then(() => true), Bun.sleep(ms).then(() => false)]);
}

async function occupyEverySlot(): Promise<PromiseWithResolvers<void>> {
  const release = Promise.withResolvers<void>();
  for (let i = 0; i < ffiPool().poolSize(); i++) void runBackgroundRender(() => release.promise);
  await until(() => _backgroundRendersRunning() === ffiPool().poolSize());
  return release;
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(2);
  }
}

describe('thumb stage and the background gate (#6020)', () => {
  it('holds a stale RAW thumb while an on-demand preview waits, then renders it', async () => {
    setInteractivePreviewActive(true);
    const stage = runStage('a.cr2');
    expect(await settlesWithin(stage, 50)).toBe(false);
    expect(generated).toEqual([]);
    setInteractivePreviewActive(false);
    await stage;
    expect(generated).toEqual(['a.cr2']);
  });

  it('queues a stale RAW thumb behind a RAW render that holds every slot', async () => {
    const release = await occupyEverySlot();
    const stage = runStage('b.nef');
    expect(await settlesWithin(stage, 50)).toBe(false);
    release.resolve();
    await stage;
    expect(generated).toEqual(['b.nef']);
  });

  for (const filename of ['c.jpg', 'd.heic', 'e.mp4']) {
    it(`renders ${filename} without touching the gate`, async () => {
      const release = await occupyEverySlot();
      setInteractivePreviewActive(true);
      const stage = runStage(filename);
      expect(await settlesWithin(stage, 500)).toBe(true);
      expect(generated).toEqual([filename]);
      expect(_backgroundRendersRunning()).toBe(ffiPool().poolSize());
      release.resolve();
    });
  }

  it('takes no slot for a fresh RAW thumb', async () => {
    const release = await occupyEverySlot();
    setInteractivePreviewActive(true);
    const stage = runStage('f.dng', true);
    expect(await settlesWithin(stage, 500)).toBe(true);
    release.resolve();
  });

  describe('stage outcomes for a stale thumb', () => {
    it('defers while the decoder is missing', async () => {
      const available = spyOn(ffiPool(), 'available').mockReturnValue(false);
      try {
        const result = await runStage('g.cr2');
        expect(result).toMatchObject({ defer: { reason: 'derivative-ffi-unavailable' } });
        expect(generated).toEqual([]);
      } finally {
        available.mockRestore();
      }
    });

    const failures: Array<[string, string, () => Error, object]> = [
      [
        'a decode over the memory budget',
        'h.cr2',
        () => new DecodeMemoryBudgetError(2, 1),
        { defer: { reason: 'decode-exceeds-memory-budget' } },
      ],
      [
        'an unsupported camera',
        'i.cr2',
        () => new UnsupportedCameraError('/i.cr2', 'unknown body'),
        { defer: { reason: 'camera-unsupported' } },
      ],
      [
        'a video without a stream',
        'j.mp4',
        () => new NoVideoStreamError('/j.mp4'),
        { skip: 'no-video-stream' },
      ],
    ];
    for (const [label, filename, makeError, expected] of failures) {
      it(`maps ${label}`, async () => {
        generateImpl = () => Promise.reject(makeError());
        expect(await runStage(filename)).toMatchObject(expected);
      });
    }
  });
});
