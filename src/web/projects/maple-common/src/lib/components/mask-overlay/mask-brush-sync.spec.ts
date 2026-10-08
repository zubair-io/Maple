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

const brushLayer = (dabs: BrushDab[], digest = brushDigest(dabs)): LocalAdjustment => ({
  mask: { kind: 'brush', dabs, digest, rasterId: 0 } satisfies BrushMask,
  adjustments: {},
});

interface FakeIo extends BrushSyncIo {
  layers: LocalAdjustment[];
  uploads: BrushRasterUpload[];
  released: number[];
  stamps: Array<[number, string]>;
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
    stamps: [] as Array<[number, string]>,
    dims: (): { width: number; height: number } | null => ({ width: 3000, height: 2000 }),
    register: (upload: BrushRasterUpload) => {
      io.uploads.push(upload);
      return new Promise<number>((resolve, reject) => outstanding.push({ resolve, reject }));
    },
    release: (rasterId: number) => {
      io.released.push(rasterId);
    },
    stampDigest: (index: number, digest: string) => {
      io.stamps.push([index, digest]);
      const mask = io.layers[index]?.mask;
      if (mask?.kind === 'brush') mask.digest = digest;
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
  it('uploads an unregistered stroke under the digest it carries, without stamping', async () => {
    const layers = [brushLayer([dab(0.1), dab(0.2)], 'abcdef0123456789')];
    const io = makeIo(layers);
    new BrushRasterSync(io).sync(layers);
    expect(io.uploads).toHaveLength(1);
    expect(io.uploads[0]).toMatchObject({ digest: 'abcdef0123456789', width: 1024, height: 682 });
    expect(io.uploads[0].dabs).toHaveLength(12);
    io.resolveOldest(7);
    await flush();
    expect(io.stamps).toEqual([]);
    expect(io.layers[0].mask).toMatchObject({ digest: 'abcdef0123456789', rasterId: 0 });
    expect(io.released).toEqual([]);
  });

  it('names a stroke that carries no usable digest, then uploads it', () => {
    const layers = [brushLayer([dab(0.1)], '')];
    const io = makeIo(layers);
    const sync = new BrushRasterSync(io);
    sync.sync(layers);
    expect(io.stamps).toEqual([[0, brushDigest([dab(0.1)])]]);
    expect(io.uploads).toHaveLength(0);
    sync.sync(layers);
    expect(io.uploads).toHaveLength(1);
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

  it('re-registers the same stroke on a differently shaped photo', async () => {
    const layers = [brushLayer([dab(0.1)])];
    const io = makeIo(layers);
    const sync = new BrushRasterSync(io);
    sync.sync(layers);
    io.resolveOldest(3);
    await flush();
    io.dims = () => ({ width: 2000, height: 3000 });
    sync.sync(layers);
    expect(io.uploads).toHaveLength(2);
    expect(io.uploads[1]).toMatchObject({ width: 682, height: 1024 });
    expect(io.released).toEqual([3]);
    io.resolveOldest(4);
    await flush();
    sync.sync(layers);
    expect(io.uploads).toHaveLength(2);
    expect(io.released).toEqual([3]);
  });

  it('keeps a registration while no photo is focused', async () => {
    const layers = [brushLayer([dab(0.1)])];
    const io = makeIo(layers);
    const sync = new BrushRasterSync(io);
    sync.sync(layers);
    io.resolveOldest(3);
    await flush();
    io.dims = () => null;
    sync.sync(layers);
    expect(io.released).toEqual([]);
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

  it('releases an upload the stroke outgrew mid-flight, then keeps the new content', async () => {
    const first = [dab(0.1)];
    const layers = [brushLayer(first)];
    const io = makeIo(layers);
    const sync = new BrushRasterSync(io);
    sync.sync(layers);
    // The drag appends a dab before the first upload completes.
    layers[0] = brushLayer([...first, dab(0.2)]);
    sync.sync(layers);
    expect(io.uploads).toHaveLength(2);
    io.resolveOldest(3);
    await flush();
    expect(io.released).toEqual([3]);
    io.resolveOldest(4);
    await flush();
    sync.sync(layers);
    expect(io.released).toEqual([3]);
    expect(io.uploads).toHaveLength(2);
  });

  it('keeps an upload whose layer moved index mid-flight', async () => {
    const brush = brushLayer([dab(0.1)]);
    const linear: LocalAdjustment = {
      mask: { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, feather: 0.5 },
      adjustments: {},
    };
    const io = makeIo([linear, brush]);
    const sync = new BrushRasterSync(io);
    sync.sync([linear, brush]);
    sync.sync([brush]);
    io.resolveOldest(3);
    await flush();
    sync.sync([brush]);
    expect(io.released).toEqual([]);
    expect(io.uploads).toHaveLength(1);
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

  it('re-sends an upload that was in flight when the worker was recreated', async () => {
    const layers = [brushLayer([dab(0.1)])];
    const io = makeIo(layers);
    const sync = new BrushRasterSync(io);
    sync.sync(layers);
    sync.reset();
    sync.sync(layers);
    expect(io.uploads).toHaveLength(2);
    io.resolveOldest(3);
    io.resolveOldest(4);
    await flush();
    expect(io.released).toEqual([3]);
    sync.sync(layers);
    expect(io.uploads).toHaveLength(2);
  });

  it('neither uploads nor stamps an empty stroke', () => {
    const layers = [brushLayer([], '')];
    const io = makeIo(layers);
    new BrushRasterSync(io).sync(layers);
    expect(io.uploads).toHaveLength(0);
    expect(io.stamps).toEqual([]);
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
