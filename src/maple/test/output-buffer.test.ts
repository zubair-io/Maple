import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import { dlopen, FFIType, ptr, type FFIFunction } from 'bun:ffi';
import { getFfiSymbols } from '../src/ffi-symbols';
import { findNativeLib, loadNativeBinding } from '../src/native';
import { createRasterV2Binding } from '../src/native-raster-v2';
import { createRasterPipelineBinding } from '../src/native-raster-pipeline';
import { initialPipelineCapacity } from '../src/native-output-buffer';
import { maple } from '../src/index';
import {
  maple as publishedMaple,
  getMapleExecutionMode,
  setMapleExecutionMode,
} from '../dist/index.js';

const native = loadNativeBinding();
const lib = dlopen(findNativeLib()!, getFfiSymbols(FFIType) as Record<string, FFIFunction>);
afterAll(() => lib.close());

function recorder() {
  const calls: { name: string; capacity: number }[] = [];
  const symbols = Object.fromEntries(
    [
      ['maple_raster_render_buf', 10],
      ['maple_raster_from_raw_render_buf', 13],
      ['maple_raster_pipeline_buf', 6],
    ].map(([name, capacityIndex]) => [
      name,
      (...args: unknown[]) => {
        calls.push({ name: String(name), capacity: Number(args[Number(capacityIndex)]) });
        const fn = lib.symbols[name as keyof typeof lib.symbols] as unknown as (
          ...values: unknown[]
        ) => unknown;
        return fn(...args);
      },
    ]),
  );
  const error = () => native.lastError();
  const probe = (bytes: Uint8Array) => native.rasterProbeMetadataBuf(bytes);
  return {
    calls,
    render: createRasterV2Binding({ symbols }, ptr, error, probe),
    pipeline: createRasterPipelineBinding({ symbols }, ptr, error, probe),
  };
}

const recipe = (ops: Record<string, unknown>[], format: string, input = { kind: 'encoded' }) =>
  JSON.stringify({ v: 1, input, ops, output: { format }, metadata: { keep: false } });

describe('native output allocation (#3526)', () => {
  it('ships the raw sizing fix through the public compiled package', async () => {
    const jpeg = await maple({
      data: new Uint8Array(1024 * 512 * 3).fill(80),
      width: 1024,
      height: 512,
      channels: 3,
    })
      .toFormat('jpeg')
      .toBuffer();
    const allocate = Buffer.alloc;
    const capacities: number[] = [];
    const allocationSpy = spyOn(Buffer, 'alloc').mockImplementation((size, fill, encoding) => {
      if (size >= 65536) capacities.push(size);
      return allocate(size, fill, encoding);
    });
    const priorMode = getMapleExecutionMode();
    setMapleExecutionMode('sync');
    try {
      const result = await publishedMaple(jpeg).ensureAlpha().toRawAlpha();
      expect([result.width, result.height, result.channels, result.data.length]).toEqual([
        1024,
        512,
        4,
        1024 * 512 * 4,
      ]);
      expect(capacities).toEqual([1024 * 512 * 4]);
    } finally {
      allocationSpy.mockRestore();
      setMapleExecutionMode(priorMode);
    }
  });

  it('sizes real large-TIFF AVIF thumbnails from the target in both bindings', async () => {
    const width = 6000;
    const height = 3200;
    const pixels = new Uint8Array(width * height * 3).fill(90);
    const tiff = await maple({ data: pixels, width, height, channels: 3 })
      .tiff({ compression: 'none' })
      .toBuffer();
    expect(tiff.byteLength).toBeGreaterThan(55_000_000);
    const recorded = recorder();
    const v2 = recorded.render.rasterRenderBuf(tiff, 512, 512, 0, 0, 'avif', 50, 0);
    const pipeline = recorded.pipeline.rasterPipelineBuf(
      tiff,
      recipe([{ op: 'resize', width: 512, height: 512, fit: 'inside' }], 'avif'),
      new Uint8Array(),
    );
    const rawInput = recorded.render.rasterFromRawRenderBuf(
      pixels,
      width,
      height,
      3,
      512,
      512,
      0,
      0,
      'avif',
      50,
      0,
    );
    for (const result of [v2, pipeline, rawInput]) {
      expect(result.ok).toBe(true);
      expect(result.buffer!.byteLength).toBeLessThan(65536);
      const metadata = await maple(result.buffer!).metadata();
      expect([metadata.width, metadata.height]).toEqual([512, 273]);
    }
    expect(recorded.calls).toHaveLength(3);
    expect(recorded.calls.every(({ capacity }) => capacity <= 327680)).toBe(true);
  }, 30000);

  it('decodes a compressed JPEG to raw alpha once using its header dimensions', async () => {
    const jpeg = await maple({
      data: new Uint8Array(1024 * 512 * 3).fill(80),
      width: 1024,
      height: 512,
      channels: 3,
    })
      .toFormat('jpeg')
      .toBuffer();
    expect(jpeg.byteLength * 2).toBeLessThan(1024 * 512 * 4);
    const recorded = recorder();
    const result = recorded.pipeline.rasterPipelineBuf(
      jpeg,
      recipe([{ op: 'ensureAlpha' }], 'raw'),
      new Uint8Array(),
    );
    expect(result.ok).toBe(true);
    expect([result.width, result.height, result.channels, result.buffer?.length]).toEqual([
      1024,
      512,
      4,
      1024 * 512 * 4,
    ]);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0].capacity).toBe(1024 * 512 * 4);
    expect(result.buffer![3]).toBe(255);
  });

  it('retains the exact native retry for geometry that grows beyond the resize estimate', async () => {
    const png = await maple({
      data: new Uint8Array(10 * 10 * 3).fill(50),
      width: 10,
      height: 10,
      channels: 3,
    })
      .toFormat('png')
      .toBuffer();
    const recorded = recorder();
    const result = recorded.pipeline.rasterPipelineBuf(
      png,
      recipe(
        [
          { op: 'resize', width: 10, height: 10 },
          { op: 'extend', top: 100, bottom: 100, left: 100, right: 100 },
          { op: 'ensureAlpha' },
        ],
        'raw',
      ),
      new Uint8Array(),
    );
    expect(result.ok).toBe(true);
    expect([result.width, result.height, result.buffer?.length]).toEqual([210, 210, 176400]);
    expect(recorded.calls.map(({ capacity }) => capacity)).toEqual([65936, 176400]);
  });

  it('sizes an extracted raw result from the crop rather than the full source', async () => {
    const jpeg = await maple({
      data: new Uint8Array(1024 * 512 * 3).fill(80),
      width: 1024,
      height: 512,
      channels: 3,
    })
      .toFormat('jpeg')
      .toBuffer();
    const recorded = recorder();
    const result = recorded.pipeline.rasterPipelineBuf(
      jpeg,
      recipe(
        [{ op: 'extract', left: 0, top: 0, width: 64, height: 32 }, { op: 'ensureAlpha' }],
        'raw',
      ),
      new Uint8Array(),
    );
    expect([result.ok, result.width, result.height, result.buffer?.length]).toEqual([
      true,
      64,
      32,
      8192,
    ]);
    expect(recorded.calls.map(({ capacity }) => capacity)).toEqual([73728]);
  });

  it('does not allocate from malformed or hostile dimensions before native validation', () => {
    const probe = () => ({
      ok: true,
      metadata: { width: 100000, height: 100000, channels: 3, orientation: 1, format: 'tiff' },
    });
    expect(initialPipelineCapacity(new Uint8Array(1), 'not json', probe)).toBe(65536);
    expect(initialPipelineCapacity(new Uint8Array(1), recipe([], 'raw'), probe)).toBe(65536);
    const recorded = recorder();
    const result = recorded.pipeline.rasterPipelineBuf(
      new Uint8Array([1]),
      'not json',
      new Uint8Array(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('parse failed');
    expect(recorded.calls.map(({ capacity }) => capacity)).toEqual([65536]);
  });
});
