import { describe, expect, it, spyOn } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  getMapleExecutionMode,
  loadNativeBinding,
  maple,
  setMapleExecutionMode,
  type RawPixelInput,
} from '../src/index.ts';
import { _resetNapiBindingForTests } from '../src/native-napi.ts';

const raw: RawPixelInput = {
  data: new Uint8Array(8 * 4 * 3).fill(128),
  width: 8,
  height: 4,
  channels: 3,
};
const dng = resolve(import.meta.dir, '../../../test-fixtures/batch-transfer/source.dng');

describe('Decode-only integrity', () => {
  it('validates each supported raster container', async () => {
    for (const format of ['png', 'jpeg', 'tiff', 'webp', 'avif'] as const) {
      const encoded = await maple(raw).toFormat(format).toBuffer();
      expect(await maple(encoded).validateIntegrity()).toEqual({ ok: true });
    }
  });

  it('accepts a PNG wider than the JPEG encoder can represent', async () => {
    const encoded = await maple({
      ...raw,
      data: new Uint8Array(65_536 * 3),
      width: 65_536,
      height: 1,
    })
      .png()
      .toBuffer();
    await expect(maple(encoded).jpeg().toBuffer()).rejects.toThrow(/65535/);
    expect(await maple(encoded).validateIntegrity()).toEqual({ ok: true });
  });

  it('validates the original without executing or clearing queued edits', async () => {
    const encoded = await maple(raw).png().toBuffer();
    const image = maple(encoded).avif({ chromaSubsampling: '4:2:0' });
    expect(await image.validateIntegrity()).toEqual({ ok: true });
    await expect(image.toBuffer()).rejects.toThrow(/chromaSubsampling/);
  });

  it('reports corrupt pixel data even when metadata still parses', async () => {
    const encoded = await maple(raw).png().toBuffer();
    const idat = encoded.indexOf('IDAT');
    expect(idat).toBeGreaterThan(0);
    const corrupted = Buffer.from(encoded);
    const length = corrupted.readUInt32BE(idat - 4);
    corrupted.fill(0, idat + 4, idat + 4 + length);
    expect((await maple(corrupted).metadata()).width).toBe(8);
    const result = await maple(corrupted).validateIntegrity();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/decode|CRC|checksum/i);
  });

  it('preserves read errors and names an empty input', async () => {
    const missing = await maple('/missing/maple-integrity.png').validateIntegrity();
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('ENOENT');
    expect(() => maple(new Uint8Array())).toThrow('Input Buffer is empty');
  });

  it('decodes a real RAW path and buffer without changing the original', async () => {
    const original = await readFile(dng);
    expect(await maple(dng).validateIntegrity()).toEqual({ ok: true });
    expect(await maple(original).validateIntegrity()).toEqual({ ok: true });
    expect(await readFile(dng)).toEqual(original);
  });

  it('rejects a corrupt RAW with the decoder reason', async () => {
    const original = await readFile(dng);
    const result = await maple(original.subarray(0, 128)).validateIntegrity();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it('validates raw pixel dimensions, channels and length without encoding them', async () => {
    for (const channels of [1, 3, 4] as const) {
      expect(
        await maple({
          ...raw,
          channels,
          data: new Uint8Array(8 * 4 * channels),
        }).validateIntegrity(),
      ).toEqual({ ok: true });
    }
    for (const invalid of [
      { ...raw, width: 0 },
      { ...raw, width: 1.5 },
      { ...raw, channels: 2 },
      { ...raw, data: new Uint8Array(1) },
    ]) {
      const result = await maple(invalid as RawPixelInput).validateIntegrity();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Invalid raw pixel');
    }
  });

  it('makes one read-only native call and no render or pipeline calls', async () => {
    const encoded = await maple(raw).png().toBuffer();
    const priorMode = getMapleExecutionMode();
    const priorNapi = process.env.MAPLE_NAPI;
    process.env.MAPLE_NAPI = '0';
    _resetNapiBindingForTests();
    setMapleExecutionMode('sync');
    const native = loadNativeBinding();
    const analyze = spyOn(native, 'rasterAnalyzeBuf');
    const render = spyOn(native, 'rasterRenderBuf');
    const pipeline = spyOn(native, 'rasterPipelineBuf');
    try {
      expect(await maple(encoded).validateIntegrity()).toEqual({ ok: true });
      expect(analyze).toHaveBeenCalledTimes(1);
      expect(JSON.parse(analyze.mock.calls[0][1])).toEqual({ v: 1, what: ['integrity'] });
      expect(render).not.toHaveBeenCalled();
      expect(pipeline).not.toHaveBeenCalled();
    } finally {
      analyze.mockRestore();
      render.mockRestore();
      pipeline.mockRestore();
      setMapleExecutionMode(priorMode);
      if (priorNapi === undefined) delete process.env.MAPLE_NAPI;
      else process.env.MAPLE_NAPI = priorNapi;
      _resetNapiBindingForTests();
    }
  });
});
