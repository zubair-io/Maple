import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';

const repoRoot = path.resolve(__dirname, '../../..');
const fixtureDng = path.join(repoRoot, 'test-fixtures/batch-transfer/source.dng');

/** Gate for #3506: encoder options through the real FFI. */
describe('Encoder options', () => {
  const noise = (w: number, h: number) => ({
    data: new Uint8Array(
      Array.from({ length: w * h * 3 }, (_, i) => (Math.imul(i, 2654435761) >>> 13) & 0xff),
    ),
    width: w,
    height: h,
    channels: 3 as const,
  });
  const src = (w = 64, h = 64) => maple(noise(w, h)).toFormat('png').toBuffer();

  it('jpeg({ progressive }) writes a progressive scan', async () => {
    const out = await maple(await src())
      .jpeg({ progressive: true })
      .toBuffer();
    const hasSof2 = out.some((b, i) => b === 0xff && out[i + 1] === 0xc2);
    expect(hasSof2).toBe(true);
  });

  it('jpeg({ chromaSubsampling: "4:4:4" }) is larger than 4:2:0', async () => {
    const input = await src();
    const a = await maple(input).jpeg({ quality: 80 }).toBuffer();
    const b = await maple(input).jpeg({ quality: 80, chromaSubsampling: '4:4:4' }).toBuffer();
    expect(b.length).toBeGreaterThan(a.length);
  });

  it('png({ compressionLevel }) changes the file size', async () => {
    const input = await src();
    const fast = await maple(input).png({ compressionLevel: 0 }).toBuffer();
    const best = await maple(input).png({ compressionLevel: 9 }).toBuffer();
    expect(best.length).toBeLessThanOrEqual(fast.length);
  });

  it('png({ palette: true }) writes an indexed PNG', async () => {
    const flat = {
      data: new Uint8Array(
        Array.from({ length: 64 * 64 }, (_, i) => [(i % 5) * 40, 200, 128]).flat(),
      ),
      width: 64,
      height: 64,
      channels: 3 as const,
    };
    const out = await maple(flat).png({ palette: true, colours: 16 }).toBuffer();
    expect(out.includes(Buffer.from('PLTE'))).toBe(true);
  });

  // NOTE: deviates from the F5 brief, which used `chromaSubsampling: '4:2:0'`
  // here. The vendored ravif 0.13 hard-codes 4:4:4 chroma planes in every
  // encode path (see raster_encode_avif.rs's module doc), so `'4:2:0'` is a
  // named rejection, not a working option — using it would make this
  // round-trip test itself fail. `'4:4:4'` (sharp's own AVIF default) is
  // the value this encoder actually produces.
  it('avif({ effort, chromaSubsampling }) round-trips', async () => {
    const out = await maple(await src(48, 48))
      .avif({ quality: 55, effort: 8, chromaSubsampling: '4:4:4' })
      .toBuffer();
    const meta = await maple(out).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([48, 48, 'avif']);
  });

  it('avif({ chromaSubsampling: "4:2:0" }) is a named rejection', async () => {
    await expect(
      maple(await src())
        .avif({ chromaSubsampling: '4:2:0' })
        .toBuffer(),
    ).rejects.toThrow(/4:2:0/);
  });

  // NOTE: deviates from the F5 brief, which asserted this round-trips
  // exactly. F4 (raw-core commit 51266ce1a) made AVIF `lossless: true` a
  // named rejection instead: the vendored rav1e never reaches true AV1
  // lossless mode (its base_q_idx floor is 1, not 0 — see
  // raster_encode_avif.rs's module doc), so quality-100 "lossless" was
  // exact only on smooth test images, not in general. This test now pins
  // the rejection rather than a guarantee the encoder doesn't provide.
  it('avif({ lossless: true }) is a named rejection, not a silent lossy fallback', async () => {
    await expect(
      maple(await src())
        .avif({ lossless: true })
        .toBuffer(),
    ).rejects.toThrow(/lossless/);
  });

  // sharp's png() implies palette from colours/colors/dither; Maple's
  // encoder only reaches the quantiser when `palette` is set, so without the
  // implication `png({ colours: 4 })` wrote a plain RGB PNG with no PLTE
  // chunk while sharp wrote an indexed one.
  it('png({ colours | colors | dither }) implies palette: true', async () => {
    const flat = {
      data: new Uint8Array(
        Array.from({ length: 64 * 64 }, (_, i) => [(i % 6) * 40, 200, 128]).flat(),
      ),
      width: 64,
      height: 64,
      channels: 3 as const,
    };
    for (const options of [{ colours: 4 }, { colors: 4 }, { dither: 0 }]) {
      const out = await maple(flat).png(options).toBuffer();
      expect(out.includes(Buffer.from('PLTE'))).toBe(true);
      // Colour type 3 (indexed) at byte 25 of the IHDR.
      expect(out[25]).toBe(3);
    }
    // No implying key: plain truecolour, as before.
    const plain = await maple(flat).png().toBuffer();
    expect(plain.includes(Buffer.from('PLTE'))).toBe(false);
    // An explicit palette: false wins over the implication.
    const forced = await maple(flat).png({ colours: 4, palette: false }).toBuffer();
    expect(forced.includes(Buffer.from('PLTE'))).toBe(false);
  });

  // The `pixi` box records bits-per-channel. `ravif`'s own builder default
  // is `BitDepth::Auto` = 10, and a 10-bit AV1 bitstream is undecodable by
  // libheif's prebuilt decoders (sharp's included), so the default here must
  // be 8 and an explicit 10 must actually reach the file.
  const pixiDepths = (bytes: Buffer): number[] => {
    const at = bytes.indexOf(Buffer.from('pixi'));
    expect(at).toBeGreaterThan(0);
    const count = bytes[at + 8];
    return Array.from(bytes.subarray(at + 9, at + 9 + count));
  };

  it('avif() defaults to 8-bit and avif({ bitdepth: 10 }) writes 10', async () => {
    const input = await src(48, 48);
    expect(pixiDepths(await maple(input).avif().toBuffer())).toEqual([8, 8, 8]);
    expect(pixiDepths(await maple(input).avif({ bitdepth: 8 }).toBuffer())).toEqual([8, 8, 8]);
    expect(pixiDepths(await maple(input).avif({ bitdepth: 10 }).toBuffer())).toEqual([10, 10, 10]);
  });

  it('avif({ bitdepth: 12 }) is a named rejection', async () => {
    await expect(
      maple(await src(48, 48))
        .avif({ bitdepth: 12 as never })
        .toBuffer(),
    ).rejects.toThrow(/bitdepth 12/);
  });

  it('tiff({ compression }) shrinks the file', async () => {
    const input = await src();
    const plain = await maple(input).tiff({ compression: 'none' }).toBuffer();
    const lzw = await maple(input).tiff({ compression: 'lzw' }).toBuffer();
    const deflate = await maple(input).tiff({ compression: 'deflate' }).toBuffer();
    expect(lzw.length).toBeLessThan(plain.length);
    expect(deflate.length).toBeLessThan(plain.length);
  });

  // #3506 F6: sharp defaults TIFF compression to 'jpeg'; Maple has no
  // JPEG-in-TIFF encoder (README parity note) and rejects the value by name
  // rather than silently falling back to 'lzw'.
  it("tiff({ compression: 'jpeg' }) is a named rejection", async () => {
    await expect(
      maple(await src())
        .tiff({ compression: 'jpeg' as never })
        .toBuffer(),
    ).rejects.toThrow(/jpeg/);
  });

  // #3506 F6: predictor moved from a bool to sharp's string form.
  it("tiff({ predictor: 'none' }) writes tag 317 as 1 (None)", async () => {
    const input = await src();
    const withPredictor = await maple(input).tiff({ predictor: 'horizontal' }).toBuffer();
    const withoutPredictor = await maple(input).tiff({ predictor: 'none' }).toBuffer();
    // Not a size assertion (LZW-with-predictor can occasionally lose to
    // plain LZW on some inputs) — both must still decode losslessly to the
    // same pixels regardless of which predictor setting wrote them.
    const a = await maple(withPredictor).toRaw();
    const b = await maple(withoutPredictor).toRaw();
    expect(a.data).toEqual(b.data);
  });

  it("tiff({ predictor: 'float' }) is a named rejection", async () => {
    await expect(
      maple(await src())
        .tiff({ predictor: 'float' as never })
        .toBuffer(),
    ).rejects.toThrow(/float/);
  });

  it('webp({ lossless: false }) fails with a message naming the limitation', async () => {
    await expect(
      maple(await src())
        .webp({ lossless: false })
        .toBuffer(),
    ).rejects.toThrow(/lossless-only/);
  });

  // NOTE: deviates from the F5 brief's `.rejects.toThrow()` shape.
  // `rejectUnsupported` runs synchronously inside `.jpeg()` itself (by
  // design — the same immediate-validation style `composite()`'s
  // left/top check already uses), so the throw happens while building the
  // chain, not inside the `toBuffer()` promise; `.rejects` never sees it.
  it('rejects mozjpeg and trellisQuantisation by name', async () => {
    const input = await src();
    expect(() => maple(input).jpeg({ mozjpeg: true } as never)).toThrow(/mozjpeg/);
  });

  // #3506 F6: cross-checked the full sharp option list per format and named
  // every option Maple silently dropped before this task. One case per new
  // rejection, all synchronous (same reasoning as the mozjpeg case above).
  it('rejects the American spelling of trellisQuantization by name', async () => {
    const input = await src();
    expect(() => maple(input).jpeg({ trellisQuantization: true } as never)).toThrow(
      /trellisQuantization/,
    );
  });

  it('rejects force on every format that has it', async () => {
    const input = await src();
    expect(() => maple(input).jpeg({ force: false } as never)).toThrow(/force/);
    expect(() => maple(input).png({ force: false } as never)).toThrow(/force/);
    expect(() => maple(input).webp({ force: false } as never)).toThrow(/force/);
    expect(() => maple(input).avif({ force: false } as never)).toThrow(/force/);
    expect(() => maple(input).tiff({ force: false } as never)).toThrow(/force/);
  });

  it('rejects png quantiser options quality and effort by name', async () => {
    const input = await src();
    expect(() => maple(input).png({ quality: 50 } as never)).toThrow(/quality/);
    expect(() => maple(input).png({ effort: 5 } as never)).toThrow(/effort/);
  });

  it('rejects webp quality and the animation-only options by name', async () => {
    const input = await src();
    expect(() => maple(input).webp({ quality: 50 } as never)).toThrow(/quality/);
    expect(() => maple(input).webp({ smartDeblock: true } as never)).toThrow(/smartDeblock/);
    expect(() => maple(input).webp({ loop: 0 } as never)).toThrow(/loop/);
    expect(() => maple(input).webp({ delay: 100 } as never)).toThrow(/delay/);
    expect(() => maple(input).webp({ minSize: true } as never)).toThrow(/minSize/);
    expect(() => maple(input).webp({ mixed: true } as never)).toThrow(/mixed/);
  });

  it('rejects tiff quality, tileWidth, tileHeight and resolutionUnit by name', async () => {
    const input = await src();
    expect(() => maple(input).tiff({ quality: 80 } as never)).toThrow(/quality/);
    expect(() => maple(input).tiff({ tileWidth: 256 } as never)).toThrow(/tileWidth/);
    expect(() => maple(input).tiff({ tileHeight: 256 } as never)).toThrow(/tileHeight/);
    expect(() => maple(input).tiff({ resolutionUnit: 'inch' } as never)).toThrow(/resolutionUnit/);
  });

  // `stateToOutput` returns `state.output` verbatim once a per-format method
  // has run, so a later `.quality()` used to be silently inert: measured at
  // 1436 B for `.jpeg().quality(30)`, byte-identical to a plain `.jpeg()`
  // (quality 80), against 716 B for `.jpeg({ quality: 30 })`.
  it('quality() after jpeg()/avif() reaches the encoder', async () => {
    const input = await src();
    const viaOption = await maple(input).jpeg({ quality: 30 }).toBuffer();
    const viaMethod = await maple(input).jpeg().quality(30).toBuffer();
    expect(viaMethod.length).toBe(viaOption.length);
    const avifOption = await maple(input).avif({ quality: 20 }).toBuffer();
    const avifMethod = await maple(input).avif().quality(20).toBuffer();
    expect(avifMethod.length).toBe(avifOption.length);
  });

  // The same shadowing made `.toFormat()` unable to change the container
  // after a per-format call. Naming a different container must discard the
  // earlier call's options rather than silently win over the last
  // instruction the caller gave.
  it('toFormat() after a per-format call changes the container', async () => {
    const out = await maple(await src())
      .jpeg({ progressive: true })
      .toFormat('png')
      .toBuffer();
    expect((await maple(out).metadata()).format).toBe('png');
  });

  it('toFormat() naming the same container keeps that call’s options', async () => {
    const out = await maple(await src())
      .jpeg({ progressive: true })
      .toFormat('jpeg', { quality: 30 })
      .toBuffer();
    const hasSof2 = out.some((b, i) => b === 0xff && out[i + 1] === 0xc2);
    expect(hasSof2).toBe(true);
    const plain = await maple(await src())
      .jpeg({ progressive: true })
      .toBuffer();
    expect(out.length).toBeLessThan(plain.length);
  });

  // The RAW-develop path goes through `exportImage`, which reads
  // `state.quality` and never sees the wire output object — so `.jpeg({
  // quality })` on a RAW input used to export at the builder's own 92
  // default, and every other per-format option was dropped without a word.
  describe('RAW develop input', () => {
    const raw = () => maple(fixtureDng);
    const tmp = (name: string) => path.join(os.tmpdir(), `maple_t2f_${Date.now()}_${name}`);

    it('honours jpeg({ quality }) on a RAW develop', async () => {
      const low = tmp('low.jpg');
      const high = tmp('high.jpg');
      expect((await raw().jpeg({ quality: 40 }).toFile(low)).ok).toBe(true);
      expect((await raw().jpeg({ quality: 95 }).toFile(high)).ok).toBe(true);
      const [lowStat, highStat] = await Promise.all([fs.stat(low), fs.stat(high)]);
      expect(lowStat.size).toBeLessThan(highStat.size);
      await Promise.all([fs.unlink(low), fs.unlink(high)]);
    });

    it('names any other per-format option instead of dropping it', async () => {
      const cases: Array<[string, () => Promise<unknown>]> = [
        ['progressive', () => raw().jpeg({ progressive: true }).toBuffer()],
        ['chromaSubsampling', () => raw().jpeg({ chromaSubsampling: '4:4:4' }).toBuffer()],
        ['palette', () => raw().png({ palette: true }).toBuffer()],
        ['compression', () => raw().tiff({ compression: 'deflate' }).toBuffer()],
        ['effort', () => raw().avif({ effort: 2 }).toBuffer()],
      ];
      for (const [option, run] of cases) {
        await expect(run()).rejects.toThrow(
          new RegExp(`${option} is not supported on a RAW develop input yet — see #3579`),
        );
      }
    });
  });

  // Out-of-range numerics were variously clamped (quality 0 encoded at 1),
  // silently ignored (compressionLevel 42 behaved as 6, colours 999 did
  // nothing) or reported by wire position ("invalid value: integer 500,
  // expected u8 at line 1 column 186"). They now throw in sharp's own
  // wording — synchronous, like every other option rejection here.
  it('range-checks numeric options in sharp’s own wording', async () => {
    const input = await src();
    const cases: Array<[() => unknown, RegExp]> = [
      [
        () => maple(input).jpeg({ quality: 0 }),
        /Expected integer between 1 and 100 for quality but received 0/,
      ],
      [
        () => maple(input).jpeg({ quality: 500 }),
        /Expected integer between 1 and 100 for quality but received 500/,
      ],
      [
        () => maple(input).png({ compressionLevel: 42 }),
        /Expected integer between 0 and 9 for compressionLevel but received 42/,
      ],
      [
        () => maple(input).png({ colours: 999 }),
        /Expected integer between 2 and 256 for colours but received 999/,
      ],
      [
        () => maple(input).png({ colors: 1 }),
        /Expected integer between 2 and 256 for colours but received 1/,
      ],
      [
        () => maple(input).avif({ effort: 99 }),
        /Expected integer between 0 and 9 for effort but received 99/,
      ],
      [
        () => maple(input).avif({ quality: 0 }),
        /Expected integer between 1 and 100 for quality but received 0/,
      ],
      [
        () => maple(input).png({ compressionLevel: 3.5 }),
        /Expected integer between 0 and 9 for compressionLevel but received 3.5/,
      ],
    ];
    for (const [call, message] of cases) {
      expect(call).toThrow(message);
    }
    // The ends of every range still pass.
    expect(() => maple(input).jpeg({ quality: 1 })).not.toThrow();
    expect(() => maple(input).jpeg({ quality: 100 })).not.toThrow();
    expect(() => maple(input).png({ compressionLevel: 0, colours: 2 })).not.toThrow();
    expect(() => maple(input).avif({ effort: 9, quality: 100 })).not.toThrow();
  });

  // `.quality()`/`.toFormat(fmt, { quality, effort })` used to clamp out-of-range
  // values silently (`Math.max`/`Math.min` in `applyQuality`/`applyEffort`):
  // `.quality(0)` encoded at 1 and `.quality(500)` at 100 without a word,
  // same for `.toFormat('avif', { effort: 99 })` landing on 9. They now throw
  // in sharp's own wording, same as every per-format method above.
  it('quality()/toFormat() range-check like the per-format methods', async () => {
    const input = await src();
    const cases: Array<[() => unknown, RegExp]> = [
      [
        () => maple(input).quality(0),
        /Expected integer between 1 and 100 for quality but received 0/,
      ],
      [
        () => maple(input).quality(500),
        /Expected integer between 1 and 100 for quality but received 500/,
      ],
      [
        () => maple(input).toFormat('jpeg', { quality: 0 }),
        /Expected integer between 1 and 100 for quality but received 0/,
      ],
      [
        () => maple(input).toFormat('avif', { effort: 99 }),
        /Expected integer between 0 and 9 for effort but received 99/,
      ],
    ];
    for (const [call, message] of cases) {
      expect(call).toThrow(message);
    }
    // The ends of every range still pass.
    expect(() => maple(input).quality(1)).not.toThrow();
    expect(() => maple(input).quality(100)).not.toThrow();
    expect(() => maple(input).toFormat('avif', { effort: 0 })).not.toThrow();
    expect(() => maple(input).toFormat('avif', { effort: 9 })).not.toThrow();
  });

  it('no longer rejects avif({ tune }) — tune is not a real sharp option', async () => {
    // #3506 F6: `tune` was never a sharp option (`avif()` delegates to
    // `heif()`, whose documented surface has no `tune` field at all); F5
    // rejected it by name in error. `.avif()` only ever lifts its four known
    // fields onto the wire output, so a stray `tune` key is simply ignored —
    // it must no longer throw the way `rejectUnsupported` used to make it.
    const out = await maple(await src(48, 48))
      .avif({ tune: 'ssim' } as never)
      .toBuffer();
    const meta = await maple(out).metadata();
    expect(meta.format).toBe('avif');
  });
});
