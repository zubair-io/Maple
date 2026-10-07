// mask-brush-sync.spec.ts — registry-sync unit tests (#360). The IO is
// faked: uploads resolve from a held deferred so mid-flight races (a stroke
// growing past its upload) are deterministic.

import type { BrushDab, BrushMask, LocalAdjustment } from '../../models/local-adjustment';
import type { BrushRasterUpload } from '../../raw-pipeline/raw-pipeline.brush-raster.types';
import { brushDigest } from './mask-brush';
import { BrushRasterSync, type BrushSyncIo } from './mask-brush-sync';

const dab = (x: number, erase = false): BrushDab => ({
  center: { x, y: 0.5 },
  radius: 0.05,
  feather: 0.5,
  weight: 0.5,
  erase,
});

const brushLayer = (dabs: BrushDab[], digest = '', rasterId = 0): LocalAdjustment => ({
  mask: { kind: 'brush', dabs, digest, rasterId } satisfies BrushMask,
  adjustments: {},
});

interface FakeIo extends BrushSyncIo {
  layers: LocalAdjustment[];
  uploads: BrushRasterUpload[];
  released: number[];
  /** Resolve the oldest outstanding upload with `rasterId`. */
  resolveOldest: (rasterId: number) => void;
  /** Reject every outstanding upload. */
  rejectAll: () => void;
}

function makeIo(layers: LocalAdjustment[]): FakeIo {
  const outstanding: Array<{
    resolve: (id: number) => void;
    reject: (err: Error) => void;
  }> = [];
  const io = {
    layers,
    uploads: [] as BrushRasterUpload[],
    released: [] as number[],
    dims: () => ({ width: 3000, height: 2000 }),
    register: (upload: BrushRasterUpload) => {
      io.uploads.push(upload);
      return new Promise<number>((resolve, reject) => outstanding.push({ resolve, reject }));
    },
    release: (rasterId: number) => {
      io.released.push(rasterId);
    },
    stampDigest: (index: number, digest: string) => {
      const mask = io.layers[index]?.mask;
      if (mask?.kind === 'brush') mask.digest = digest;
    },
    stampRasterId: (index: number, digest: string, rasterId: number) => {
      const mask = io.layers[index]?.mask;
      if (mask?.kind !== 'brush' || brushDigest(mask.dabs) !== digest) return false;
      mask.rasterId = rasterId;
      if (mask.digest !== digest) mask.digest = digest;
      return true;
    },
    resolveOldest: (rasterId: number) => {
      outstanding.shift()?.resolve(rasterId);
    },
    rejectAll: () => {
      outstanding.splice(0).forEach(({ reject }) => reject(new Error('worker retired')));
    },
  };
  return io;
}

/** Let every settled promise continuation run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('BrushRasterSync', () => {
  it('stamps the content digest and uploads an unregistered stroke', async () => {
    const layers = [brushLayer([dab(0.1), dab(0.2)])];
    const io = makeIo(layers);
    new BrushRasterSync(io).sync(layers);
    expect(io.layers[0].mask).toMatchObject({ digest: brushDigest([dab(0.1), dab(0.2)]) });
    expect(io.uploads).toHaveLength(1);
    expect(io.uploads[0]).toMatchObject({ width: 1024, height: 682 });
    expect(io.uploads[0].dabs).toHaveLength(12);
    io.resolveOldest(7);
    await flush();
    expect(io.layers[0].mask).toMatchObject({ rasterId: 7 });
    expect(io.released).toEqual([]);
  });

  it('does not re-upload a registered stroke', async () => {
    const layers = [brushLayer([dab(0.1)])];
    const io = makeIo(layers);
    const sync = new BrushRasterSync(io);
    sync.sync(layers);
    io.resolveOldest(3);
    await flush();
    sync.sync(layers);
    expect(io.uploads).toHaveLength(1);
    expect(io.released).toEqual([]);
  });

  it('does not double-send while an upload is in flight', () => {
    const layers = [brushLayer([dab(0.1)])];
    const io = makeIo(layers);
    const sync = new BrushRasterSync(io);
    sync.sync(layers);
    sync.sync(layers);
    expect(io.uploads).toHaveLength(1);
  });

  it('releases the raster whose stroke disappeared', async () => {
    const layers = [brushLayer([dab(0.1)])];
    const io = makeIo(layers);
    const sync = new BrushRasterSync(io);
    sync.sync(layers);
    io.resolveOldest(3);
    await flush();
    sync.sync([]);
    expect(io.released).toEqual([3]);
  });

  it('releases an upload the stroke outgrew mid-flight, then uploads the new content', async () => {
    const first = [dab(0.1)];
    const layers = [brushLayer(first)];
    const io = makeIo(layers);
    const sync = new BrushRasterSync(io);
    sync.sync(layers);
    // The drag appends a dab before the first upload completes.
    (layers[0].mask as BrushMask).dabs = [...first, dab(0.2)];
    sync.sync(layers);
    expect(io.uploads).toHaveLength(2);
    io.resolveOldest(3);
    await flush();
    // Stale completion: nobody carries the old digest anymore.
    expect(io.released).toEqual([3]);
    expect(io.layers[0].mask).toMatchObject({ rasterId: 0 });
    io.resolveOldest(4);
    await flush();
    expect(io.layers[0].mask).toMatchObject({ rasterId: 4 });
    expect(io.released).toEqual([3]);
  });

  it('retries after the worker rejects an upload', async () => {
    const layers = [brushLayer([dab(0.1)])];
    const io = makeIo(layers);
    const sync = new BrushRasterSync(io);
    sync.sync(layers);
    io.rejectAll();
    await flush();
    sync.sync(layers);
    expect(io.uploads).toHaveLength(2);
  });

  it('re-uploads everything after a worker recreation', async () => {
    const layers = [brushLayer([dab(0.1)])];
    const io = makeIo(layers);
    const sync = new BrushRasterSync(io);
    sync.sync(layers);
    io.resolveOldest(3);
    await flush();
    sync.reset();
    sync.sync(layers);
    expect(io.uploads).toHaveLength(2);
  });

  it('skips the upload for an empty stroke but still stamps its digest', () => {
    const layers = [brushLayer([])];
    const io = makeIo(layers);
    new BrushRasterSync(io).sync(layers);
    expect(io.uploads).toHaveLength(0);
    expect(io.layers[0].mask).toMatchObject({ digest: brushDigest([]), rasterId: 0 });
  });

  it('ignores non-brush layers', () => {
    const layers: LocalAdjustment[] = [
      {
        mask: { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, feather: 0.5 },
        adjustments: {},
      },
    ];
    const io = makeIo(layers);
    new BrushRasterSync(io).sync(layers);
    expect(io.uploads).toHaveLength(0);
  });
});
