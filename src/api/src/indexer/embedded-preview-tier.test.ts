/**
 * #5511: a RAW whose embedded preview is smaller than the thumbnail tier is
 * developed for both tiers instead of upscaling the embedded preview. The
 * native pool is faked, so the decision is tested without the dylib; the fake
 * extraction writes a real AVIF of the size the camera embedded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, readdir, realpath, rm, writeFile } from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _setFfiPoolForTests } from '../ffi/ffi-pool.ts';
import { DecodeMemoryBudgetError } from '../ffi/decode-memory-budget.ts';
import { developRejection } from '../ffi/unsupported-camera.ts';
import { invalidateLibraryRoots } from './libraries.cache.ts';
import { generatePreview } from './previewer.ts';
import { generateThumb } from './thumbnailer.ts';
import { previewRoutes } from '../routes/library/preview.ts';
import { thumbRoutes } from '../routes/library/thumb.ts';
import { newObjectIdHex } from '../db/object-id.ts';
import { registerLibrary, seedRouteAsset } from '../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { avifLongEdgePx } from '../thumbs/embedded-preview.ts';

const REAL_AVIF = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../test-fixtures/raster-metadata/avif-validation/srgb-rgb.avif',
);

/** The part of an AVIF the size probe reads: a file-type box and an `ispe` box. */
function avifHeader(width: number, height: number): Buffer {
  const ispe = Buffer.alloc(20);
  ispe.writeUInt32BE(20, 0);
  ispe.write('ispe', 4);
  ispe.writeUInt32BE(width, 12);
  ispe.writeUInt32BE(height, 16);
  return Buffer.concat([Buffer.from('\0\0\0\x10ftypavif\0\0\0\0'), ispe]);
}

const EDITED_XMP = `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="-2"/>
</rdf:RDF></x:xmpmeta>`;

const TIERS = [
  { name: 'thumb', maxPx: 512, generate: generateThumb },
  { name: 'preview', maxPx: 1280, generate: generatePreview },
] as const;

const DEVELOPED = ['extract', 'develop', 'encode-developed'];

type Embedded = number | 'extraction-fails';

type Develop = 'ok' | 'unsupported-camera' | 'fails' | 'memory-budget';

function fakePool(embedded: Embedded, develop: Develop = 'ok') {
  const calls: string[] = [];
  const pool = {
    available: () => true,
    poolSize: () => 1,
    sidecarHasRenderAdjustments: () => Promise.resolve(true),
    async renderThumbnailAvifToFile(_raw: string, out: string, maxPx: number) {
      calls.push('extract');
      if (embedded === 'extraction-fails') throw new Error('render-failed');
      const edge = Math.min(embedded, maxPx);
      await writeFile(out, avifHeader(edge, Math.round(edge * 0.75)));
      return true;
    },
    async renderDevelopJpegToFile(raw: string, _xmp: string | null, out: string) {
      calls.push('develop');
      if (develop === 'fails') return false;
      if (develop === 'memory-budget') throw new DecodeMemoryBudgetError(8 * 1024 ** 3, 1024 ** 3);
      if (develop === 'unsupported-camera') {
        throw developRejection('unsupported camera: Hasselblad Hasselblad H2D', raw);
      }
      await writeFile(out, Buffer.from('developed'));
      return true;
    },
    async exportRecipeToFile(
      _raw: string,
      _xmp: string,
      _recipe: string,
      _film: null,
      out: string,
    ) {
      calls.push('export');
      await writeFile(out, Buffer.from('exported'));
      return true;
    },
    async renderBitmapThumbToFile(_src: string, out: string, maxPx: number) {
      calls.push('encode-developed');
      await writeFile(out, avifHeader(maxPx, Math.round(maxPx * 0.75)));
      return { ok: true };
    },
    validateAvif: () => Promise.resolve({ ok: true }),
  };
  return { calls, pool };
}

const longEdge = (file: string) => avifLongEdgePx(file);

describe('avifLongEdgePx', () => {
  it('reads the size of an AVIF written by the real encoder', async () => {
    expect(await avifLongEdgePx(REAL_AVIF)).toBe(20);
  });

  it('is null for a missing file and for bytes that are not an AVIF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maple-avif-edge-'));
    await writeFile(join(dir, 'junk.avif'), Buffer.from('not an avif'));
    expect(await avifLongEdgePx(join(dir, 'junk.avif'))).toBeNull();
    expect(await avifLongEdgePx(join(dir, 'gone.avif'))).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('embedded preview size decides extraction or develop (#5511)', () => {
  let dir: string;
  let previous: ReturnType<typeof _setFfiPoolForTests> = null;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'maple-embedded-tier-')));
  });

  afterEach(async () => {
    _setFfiPoolForTests(previous);
    await rm(dir, { recursive: true, force: true });
  });

  async function render(
    tier: (typeof TIERS)[number],
    embedded: Embedded,
    options: { sidecar?: string; develop?: Develop } = {},
  ) {
    const raw = join(dir, 'frame.3fr');
    await writeFile(raw, Buffer.alloc(1024));
    if (options.sidecar) await writeFile(join(dir, 'frame.xmp'), options.sidecar);
    const { calls, pool } = fakePool(embedded, options.develop);
    previous = _setFfiPoolForTests(pool as never);
    const out = join(dir, `${tier.name}.avif`);
    const ok = await tier.generate(raw, out);
    return { calls, ok, out };
  }

  for (const tier of TIERS) {
    describe(`${tier.name} tier`, () => {
      it('develops a 290x218 embedded preview and publishes the developed render', async () => {
        const { calls, ok, out } = await render(tier, 290);
        expect(ok).toBe(true);
        expect(calls).toEqual(DEVELOPED);
        expect(await longEdge(out)).toBe(tier.maxPx);
      });

      it('develops a 511 px embedded preview, one pixel below the minimum', async () => {
        const { calls } = await render(tier, 511);
        expect(calls).toEqual(DEVELOPED);
      });

      it('keeps a 512 px embedded preview, exactly the minimum', async () => {
        const { calls, out } = await render(tier, 512);
        expect(calls).toEqual(['extract']);
        expect(await longEdge(out)).toBe(512);
      });

      it('keeps a 600 px embedded preview', async () => {
        const { calls, out } = await render(tier, 600);
        expect(calls).toEqual(['extract']);
        expect(await longEdge(out)).toBe(Math.min(600, tier.maxPx));
      });

      it('keeps a 1024 px embedded preview', async () => {
        const { calls, out } = await render(tier, 1024);
        expect(calls).toEqual(['extract']);
        expect(await longEdge(out)).toBe(Math.min(1024, tier.maxPx));
      });

      it('keeps a full-size embedded preview, downscaled to the tier', async () => {
        const { calls, out } = await render(tier, 6000);
        expect(calls).toEqual(['extract']);
        expect(await longEdge(out)).toBe(tier.maxPx);
      });

      it('falls back to develop when extraction fails, as before', async () => {
        const { calls, ok } = await render(tier, 'extraction-fails');
        expect(ok).toBe(true);
        expect(calls).toEqual(DEVELOPED);
      });

      it('develops an asset with authored edits without extracting', async () => {
        const { calls, ok } = await render(tier, 290, { sidecar: EDITED_XMP });
        expect(ok).toBe(true);
        expect(calls).toEqual(['export', 'encode-developed']);
      });

      it('publishes the embedded preview when the camera cannot be developed', async () => {
        const { calls, ok, out } = await render(tier, 290, { develop: 'unsupported-camera' });
        expect(ok).toBe(true);
        expect(calls).toEqual(['extract', 'develop']);
        expect(await longEdge(out)).toBe(290);
        expect((await readdir(dir)).sort()).toEqual(['frame.3fr', `${tier.name}.avif`].sort());
      });

      it('publishes the embedded preview when the develop reports failure', async () => {
        const { calls, ok, out } = await render(tier, 290, { develop: 'fails' });
        expect(ok).toBe(true);
        expect(calls).toEqual(['extract', 'develop']);
        expect(await longEdge(out)).toBe(290);
        expect((await readdir(dir)).sort()).toEqual(['frame.3fr', `${tier.name}.avif`].sort());
      });

      it('publishes nothing and defers when the develop exceeds the memory budget', async () => {
        await expect(render(tier, 290, { develop: 'memory-budget' })).rejects.toBeInstanceOf(
          DecodeMemoryBudgetError,
        );
        expect(await readdir(dir)).toEqual(['frame.3fr']);
      });
    });
  }
});

describe('the on-demand routes take the same decision (#5511)', () => {
  let dir: string;
  let live: LiveTestDatabase;
  let previous: ReturnType<typeof _setFfiPoolForTests> = null;
  const app = new Elysia().use(thumbRoutes).use(previewRoutes);

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    dir = await realpath(await mkdtemp(join(tmpdir(), 'maple-embedded-route-')));
    const libraryId = registerLibrary(live.db, dir, 'tierlib');
    seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename: 'frame.3fr',
      mapleId: newObjectIdHex(),
    });
    await writeFile(join(dir, 'frame.3fr'), Buffer.alloc(1024));
  });

  afterEach(async () => {
    _setFfiPoolForTests(previous);
    invalidateLibraryRoots();
    live.close();
    await rm(dir, { recursive: true, force: true });
  });

  for (const [embedded, develop, expectedCalls] of [
    [290, 'ok', DEVELOPED],
    [290, 'unsupported-camera', ['extract', 'develop']],
    [290, 'fails', ['extract', 'develop']],
    [1024, 'ok', ['extract']],
  ] as const) {
    it(`a ${embedded} px embedded preview (develop ${develop}) answers thumb and preview the same way`, async () => {
      const { calls, pool } = fakePool(embedded, develop);
      previous = _setFfiPoolForTests(pool as never);
      for (const route of ['thumb', 'preview']) {
        calls.length = 0;
        const res = await app.handle(new Request(`http://localhost/${route}/tierlib/frame.3fr`));
        expect(res.status).toBe(200);
        expect(calls).toEqual([...expectedCalls]);
        await rm(join(dir, '.maple'), { recursive: true, force: true });
      }
    });
  }
});
