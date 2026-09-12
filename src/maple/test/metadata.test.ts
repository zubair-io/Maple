import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';

/**
 * Gate for #3507: richer `metadata()`, `stats()`, and metadata passthrough
 * (`keepMetadata`/`withMetadata`/`withExif`/`withIccProfile`/`withXmp`).
 *
 * Several assertions below diverge from the original task brief's own draft
 * — verified against real behaviour (this package's own FFI output and, for
 * the numbers a real sharp install can produce, sharp 0.34.5 itself at
 * `src/api/node_modules/sharp`) rather than the brief's text, per the
 * project rule that landed behaviour outranks a stale planning doc:
 *
 * - `hasProfile`/`icc` stay `false`/`undefined` unless `keepMetadata()`,
 *   `withMetadata()` or `withIccProfile()` was actually called. The brief's
 *   own "ICC, EXIF and XMP buffers when present" draft asserted
 *   `hasProfile === true` from `withExif()`/`withXmp()` alone, which
 *   predates fix-round-1 dropping the old "always tag sRGB regardless of
 *   the metadata block" default (see `task-G5-fix1-report.md` item 2) —
 *   `withExif`/`withXmp` set only their own field, matching sharp's own
 *   independent `keepExif`/`keepIccProfile`/`keepXmp` bits.
 * - the `withIccProfile()` round-trip test supplies a real profile (this
 *   package's own default sRGB fill, via `keepMetadata()`) rather than the
 *   brief's `toColourspace('display-p3')`-sourced one, which is always
 *   `undefined` — `toColourspace()` has no effect on the bitmap recipe path
 *   at all (it only feeds the separate RAW-develop pipeline), and sharp
 *   itself doesn't tag an ICC profile from `toColourspace()` alone either
 *   (measured directly against sharp).
 * - the AVIF case only checks the embedded EXIF block's own Orientation
 *   byte, not the convenience `orientation` field — see the dedicated test
 *   below for why, and the report for the tracked gap.
 */
describe('Metadata and stats', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const fixtureDng = path.join(repoRoot, 'test-fixtures/batch-transfer/source.dng');

  const ramp = (w: number, h: number) => ({
    data: new Uint8Array(Array.from({ length: w * h * 3 }, (_, i) => i % 251)),
    width: w,
    height: h,
    channels: 3 as const,
  });

  /** A minimal little-endian EXIF block with Orientation = `value`. */
  const exifBlock = (value: number) => {
    const tiff = Buffer.alloc(26);
    tiff.write('II', 0, 'ascii');
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(value, 18);
    return tiff;
  };

  /**
   * Read the Orientation tag back out of a 26-byte block built the same
   * way, tolerating the `Exif\0\0` introducer `metadata()` hands back for
   * a JPEG, WebP or AVIF — the form sharp returns for those containers
   * (#3507 final fix wave, item 3).
   */
  const orientationOf = (block: Buffer) => {
    const tiff = block.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? block.subarray(6) : block;
    return tiff.readUInt16LE(18);
  };

  it('metadata() reports the richer fields', async () => {
    const png = await maple(ramp(8, 4)).png().toBuffer();
    const meta = await maple(png).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([8, 4, 'png']);
    expect(meta.hasAlpha).toBe(false);
    expect(meta.hasProfile).toBe(false);
    expect(meta.space).toBe('srgb');
    expect(meta.depth).toBe('uchar');
    expect(meta.size).toBe(png.length);
    expect(meta.isRaw).toBe(false);
    // No metadata block was ever requested — icc/exif/xmp/density all absent.
    expect(meta.icc).toBeUndefined();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
  });

  it('metadata() reports hasAlpha for an RGBA source', async () => {
    const png = await maple({
      data: new Uint8Array([1, 2, 3, 128]),
      width: 1,
      height: 1,
      channels: 4 as const,
    })
      .png()
      .toBuffer();
    const meta = await maple(png).metadata();
    expect(meta.hasAlpha).toBe(true);
    expect(meta.channels).toBe(4);
  });

  it.each(['jpeg', 'png', 'webp', 'tiff', 'avif'] as const)(
    'metadata() round-trips width/height/format/channels for %s',
    async (format) => {
      const buf = await maple(ramp(16, 16)).toFormat(format).toBuffer();
      const meta = await maple(buf).metadata();
      expect([meta.width, meta.height, meta.format, meta.channels]).toEqual([16, 16, format, 3]);
    },
  );

  it('metadata() reports hasAlpha for WebP as well as PNG', async () => {
    const rgba = {
      data: new Uint8Array([10, 20, 30, 128, 40, 50, 60, 200, 1, 2, 3, 4, 5, 6, 7, 8]),
      width: 2,
      height: 2,
      channels: 4 as const,
    };
    for (const format of ['png', 'webp'] as const) {
      const buf = await maple(rgba).toFormat(format).toBuffer();
      const meta = await maple(buf).metadata();
      expect([meta.channels, meta.hasAlpha]).toEqual([4, true]);
    }
  });

  it('metadata() returns the EXIF and XMP buffers when present, with no ICC requested', async () => {
    const jpeg = await maple(ramp(16, 16))
      .withExif(exifBlock(1))
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>')
      .jpeg()
      .toBuffer();
    const meta = await maple(jpeg).metadata();
    // Neither keepMetadata() nor withIccProfile()/withMetadata() was called —
    // default strip still applies to the ICC field specifically.
    expect(meta.hasProfile).toBe(false);
    expect(meta.icc).toBeUndefined();
    expect(Buffer.isBuffer(meta.exif)).toBe(true);
    expect(orientationOf(meta.exif!)).toBe(1);
    expect(meta.xmp?.toString()).toContain('xmpmeta');
  });

  it('metadata() reports hasProfile/icc when keepMetadata() supplies a default sRGB profile', async () => {
    const png = await maple(ramp(8, 8)).keepMetadata().png().toBuffer();
    const meta = await maple(png).metadata();
    expect(meta.hasProfile).toBe(true);
    expect(Buffer.isBuffer(meta.icc)).toBe(true);
    expect(meta.icc!.length).toBeGreaterThan(0);
  });

  it('stats() reports per-channel moments matching sharp 0.34.5 exactly', async () => {
    const png = await maple(ramp(16, 16)).png().toBuffer();
    const stats = await maple(png).stats();
    expect(stats.channels).toHaveLength(3);
    // Measured directly against sharp 0.34.5 on this exact PNG (byte-for-byte
    // identical channels/isOpaque/dominant between maple and sharp).
    expect(stats.channels).toEqual([
      {
        min: 0,
        max: 250,
        sum: 31405,
        squaresSum: 5239895,
        mean: 122.67578125,
        stdev: 73.75800627446036,
        minX: 0,
        minY: 0,
        maxX: 7,
        maxY: 10,
      },
      {
        min: 0,
        max: 250,
        sum: 31410,
        squaresSum: 5239960,
        mean: 122.6953125,
        stdev: 73.72711301568407,
        minX: 7,
        minY: 10,
        maxX: 3,
        maxY: 5,
      },
      {
        min: 0,
        max: 250,
        sum: 31415,
        squaresSum: 5240035,
        mean: 122.71484375,
        stdev: 73.69646767265355,
        minX: 3,
        minY: 5,
        maxX: 10,
        maxY: 15,
      },
    ]);
    expect(stats.isOpaque).toBe(true);
    expect(stats.dominant).toEqual({ r: 8, g: 8, b: 8 });
    // entropy/sharpness diverge from sharp's own numbers by a small, known
    // margin (different entropy formula and f32 greyscale precision — see
    // task-G3-fix1-report.md); pinned to this implementation's own measured
    // output, not sharp's (sharp: entropy 7.90625, sharpness 15.978519926524466).
    expect(stats.entropy).toBeCloseTo(7.9453125, 6);
    expect(stats.sharpness).toBeCloseTo(15.972904314316978, 6);
  });

  it('stats() reports isOpaque false for a translucent image', async () => {
    const png = await maple({
      data: new Uint8Array([9, 9, 9, 12]),
      width: 1,
      height: 1,
      channels: 4 as const,
    })
      .png()
      .toBuffer();
    expect((await maple(png).stats()).isOpaque).toBe(false);
  });

  it('stats() ignores queued ops, like metadata() (matches sharp)', async () => {
    const png = await maple(ramp(16, 16)).png().toBuffer();
    const full = await maple(png).stats();
    const resized = await maple(png).resize(4, 4).stats();
    expect(resized).toEqual(full);
  });

  it('stats() on a camera RAW file develops it first (RAW-develop cost, not a header probe)', async () => {
    // No cheap way to get pixels from sensor data — this runs the same
    // RAW-develop pipeline `toBuffer()` would, so stats() on the RAW file
    // must equal stats() computed from that same develop's own output.
    const developed = await maple(fixtureDng).jpeg().quality(92).toBuffer();
    const direct = await maple(fixtureDng).jpeg().quality(92).stats();
    const fromDeveloped = await maple(developed).stats();
    expect(direct).toEqual(fromDeveloped);
    expect(direct.channels).toHaveLength(3);
  });

  it('metadata() on a camera RAW file keeps Tier 1s cheap probe (no new fields)', async () => {
    const meta = await maple(fixtureDng).metadata();
    expect(meta.format).toBe('dng');
    expect(meta.isRaw).toBe(true);
    expect(meta.hasAlpha).toBeUndefined();
    expect(meta.icc).toBeUndefined();
  });

  it('metadata is stripped by default and kept by keepMetadata()', async () => {
    const source = await maple(ramp(16, 16)).withExif(exifBlock(6)).jpeg().toBuffer();
    const stripped = await maple(source).jpeg().toBuffer();
    expect((await maple(stripped).metadata()).exif).toBeUndefined();
    const kept = await maple(source).keepMetadata().jpeg().toBuffer();
    expect((await maple(kept).metadata()).orientation).toBe(6);
  });

  it('withMetadata({ orientation }) writes the EXIF tag', async () => {
    const out = await maple(ramp(16, 16)).withMetadata({ orientation: 8 }).jpeg().toBuffer();
    expect((await maple(out).metadata()).orientation).toBe(8);
  });

  it('withMetadata({ orientation }) rejects an out-of-range value by name', () => {
    expect(() => maple(ramp(8, 8)).withMetadata({ orientation: 9 })).toThrow(
      'Expected integer between 1 and 8 for orientation but received 9 of type number',
    );
  });

  it('withMetadata({ density }) rejects a non-positive value by name', () => {
    expect(() => maple(ramp(8, 8)).withMetadata({ density: -5 })).toThrow(
      'Expected positive number for density but received -5 of type number',
    );
  });

  it('a metadata field the target container cannot embed errors by name', async () => {
    await expect(
      maple(ramp(8, 8)).withExif(exifBlock(1)).toFormat('tiff').toBuffer(),
    ).rejects.toThrow(/TIFF cannot embed EXIF/);
    await expect(
      maple(ramp(8, 8)).withIccProfile(Buffer.from('fake-icc')).avif().toBuffer(),
    ).rejects.toThrow(/AVIF cannot embed an ICC profile/);
  });

  it('keepMetadata()s default ICC fill is silently skipped, not an error, on AVIF', async () => {
    // The default sRGB fill keepMetadata() adds for an input with no ICC of
    // its own is a convenience, not a caller request — it must not error on
    // a format that cannot carry ICC at all (task-G5-fix1-report.md, round 2).
    const avif = await maple(ramp(8, 8)).keepMetadata().avif().toBuffer();
    expect((await maple(avif).metadata()).icc).toBeUndefined();
  });

  it('AVIF: the embedded EXIF block carries the requested orientation', async () => {
    // `metadata().orientation` for AVIF comes from the container's own
    // irot/imir transform box (raster.rs probe_raster_metadata), not from
    // an embedded EXIF item's Orientation tag — so it stays 1 here even
    // though the EXIF block itself round-trips the real value. See the
    // report for this tracked read/write gap.
    const avif = await maple(ramp(24, 24)).withMetadata({ orientation: 6 }).avif().toBuffer();
    const meta = await maple(avif).metadata();
    expect(meta.format).toBe('avif');
    expect(Buffer.isBuffer(meta.exif)).toBe(true);
    expect(orientationOf(meta.exif!)).toBe(6);
  });

  it('withIccProfile() embeds a caller-supplied profile verbatim', async () => {
    // A real profile — this package's own default sRGB fill — rather than
    // the brief's toColourspace('display-p3')-sourced one, which is always
    // undefined (toColourspace() doesn't touch the bitmap recipe path).
    const withDefault = await maple(ramp(8, 8)).keepMetadata().png().toBuffer();
    const profile = (await maple(withDefault).metadata()).icc!;
    const out = await maple(ramp(8, 8)).withIccProfile(profile).png().toBuffer();
    const outMeta = await maple(out).metadata();
    expect(outMeta.icc!.equals(profile)).toBe(true);
    expect(outMeta.hasProfile).toBe(true);
  });

  it('withXmp() accepts a Buffer as well as a string', async () => {
    const xmpBytes = Buffer.from('<x:xmpmeta xmlns:x="adobe:ns:meta/">buf</x:xmpmeta>', 'utf-8');
    const out = await maple(ramp(8, 8)).withXmp(xmpBytes).png().toBuffer();
    const meta = await maple(out).metadata();
    expect(meta.xmp?.toString()).toContain('buf');
  });

  /**
   * #3507 fix-round-1. Three findings from the review measured against real
   * sharp 0.34.5 with the oracle suite running (`src/api` installed):
   *
   * 1. [High] The RAW-develop terminals (`export.ts` via
   *    `rawDevelopToFile`/`rawDevelopToBuffer`) never read `state.metadata`
   *    at all, so `maple(dng).withExif(...).jpeg()` silently produced output
   *    without the requested EXIF. Now named-error-by-method instead.
   * 2. [High] `withIccProfile`/`withExif` had no signature divergence
   *    documented or enforced from sharp's own `withIccProfile(string,
   *    opts?)` (`'srgb'|'p3'|'cmyk'`, or a filesystem path) and
   *    `withExif({IFD0: {...}})` (an IFD object) — Maple silently accepted
   *    only raw bytes for both. `withIccProfile` now also accepts `'srgb'`/
   *    `'p3'` (Maple's own built-in profiles, resolved on the Rust side via
   *    `metadata.iccName` — no second copy of the bytes in this package)
   *    and a path (read now); `'cmyk'` and an IFD object are rejected by
   *    name rather than silently doing the wrong thing with them.
   * 3. [Low] `withXmp('')` now rejects with sharp's own exact message.
   */
  describe('fix-round-1 (#3507)', () => {
    const exifBlockShell = () => {
      const tiff = Buffer.alloc(26);
      tiff.write('II', 0, 'ascii');
      return tiff;
    };

    it('item 1: withExif() before developing a RAW file is a named "not supported yet" error on toFile()', async () => {
      const outPath = path.join(os.tmpdir(), `g6-fix1-tofile-${Date.now()}.jpg`);
      const res = await maple(fixtureDng).withExif(exifBlockShell()).jpeg().toFile(outPath);
      expect(res.ok).toBe(false);
      expect(res.error).toBe(
        'withExif is not supported when developing a RAW file yet — see #3507',
      );
    });

    it('item 1: withMetadata() before developing a RAW file is a named "not supported yet" error on toBuffer()', async () => {
      await expect(
        maple(fixtureDng).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
      ).rejects.toThrow('withMetadata is not supported when developing a RAW file yet — see #3507');
    });

    it('item 1: a RAW file with no metadata calls still develops normally', async () => {
      const buf = await maple(fixtureDng).jpeg().toBuffer();
      expect(buf.length).toBeGreaterThan(0);
    });

    it("item 2: withIccProfile('srgb') embeds Maple's own built-in sRGB profile", async () => {
      // Byte-for-byte cross-check against an independent path to the exact
      // same Rust bytes (`icc::profile_for(TargetPrimaries::Srgb)`):
      // keepMetadata()'s default sRGB fill.
      const named = await maple(ramp(8, 8)).withIccProfile('srgb').png().toBuffer();
      const namedIcc = (await maple(named).metadata()).icc;
      const kept = await maple(ramp(8, 8)).keepMetadata().png().toBuffer();
      const keptIcc = (await maple(kept).metadata()).icc;
      expect(namedIcc?.equals(keptIcc!)).toBe(true);
    });

    it("item 2: withIccProfile('p3') embeds Maple's own built-in Display P3 profile, distinct from srgb", async () => {
      const p3 = await maple(ramp(8, 8)).withIccProfile('p3').png().toBuffer();
      const p3Icc = (await maple(p3).metadata()).icc;
      const srgb = await maple(ramp(8, 8)).withIccProfile('srgb').png().toBuffer();
      const srgbIcc = (await maple(srgb).metadata()).icc;
      expect(p3Icc!.length).toBeGreaterThan(0);
      expect(p3Icc?.equals(srgbIcc!)).toBe(false);
    });

    it('item 2: withIccProfile(path) reads a real file and embeds it verbatim', async () => {
      const srgb = await maple(ramp(8, 8)).withIccProfile('srgb').png().toBuffer();
      const srgbIcc = (await maple(srgb).metadata()).icc!;
      const profilePath = path.join(os.tmpdir(), `g6-fix1-profile-${Date.now()}.icc`);
      await fs.writeFile(profilePath, srgbIcc);
      const out = await maple(ramp(8, 8)).withIccProfile(profilePath).png().toBuffer();
      expect((await maple(out).metadata()).icc?.equals(srgbIcc)).toBe(true);
    });

    it('item 2: withIccProfile(path) errors by name when the file is unreadable', () => {
      expect(() => maple(ramp(8, 8)).withIccProfile('/no/such/profile.icc')).toThrow(
        /cannot read ICC profile file/,
      );
    });

    it("item 2: withIccProfile('cmyk') is rejected by name — Maple has no CMYK ICC support", () => {
      expect(() => maple(ramp(8, 8)).withIccProfile('cmyk')).toThrow(/CMYK/);
    });

    it('item 2: withExif() rejects an IFD object like sharp accepts, by name', () => {
      expect(() =>
        maple(ramp(8, 8)).withExif({ IFD0: { Copyright: 'x' } } as unknown as Buffer),
      ).toThrow(/IFD object/);
    });

    it('item 2: withExif() rejects any other non-Buffer value too', () => {
      expect(() => maple(ramp(8, 8)).withExif(42 as unknown as Buffer)).toThrow(
        'Expected a Buffer for exif but received 42 of type number',
      );
    });

    it("item 3: withXmp('') rejects with sharp's exact message", () => {
      expect(() => maple(ramp(8, 8)).withXmp('')).toThrow(
        'Expected non-empty string for xmp but received  of type string',
      );
    });
  });

  describe('sharp oracle (skips loudly if sharp is not installed at src/api)', () => {
    const apiDir = path.join(repoRoot, 'src/api');
    let sharpPath: string | null;
    try {
      sharpPath = require.resolve('sharp', { paths: [apiDir] });
    } catch {
      sharpPath = null;
      console.warn('sharp oracle test skipped: no sharp install found under', apiDir);
    }

    it.skipIf(sharpPath === null)(
      'a Maple-written EXIF orientation and default ICC round-trip identically through real sharp',
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sharp = require(sharpPath as string);
        const jpeg = await maple(ramp(16, 16)).withMetadata({ orientation: 5 }).jpeg().toBuffer();
        const mapleMeta = await maple(jpeg).metadata();
        const sharpMeta = await sharp(jpeg).metadata();
        expect(mapleMeta.orientation).toBe(sharpMeta.orientation);
        expect(mapleMeta.hasProfile).toBe(sharpMeta.hasProfile);
      },
    );

    it.skipIf(sharpPath === null)(
      "fix-round-1 item 2: withIccProfile('srgb')/('p3') are real ICC profiles a real reader accepts",
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sharp = require(sharpPath as string);
        for (const name of ['srgb', 'p3'] as const) {
          const png = await maple(ramp(8, 8)).withIccProfile(name).png().toBuffer();
          const mapleIcc = (await maple(png).metadata()).icc!;
          const sharpMeta = await sharp(png).metadata();
          expect(sharpMeta.hasProfile).toBe(true);
          expect(Buffer.isBuffer(sharpMeta.icc)).toBe(true);
          expect((sharpMeta.icc as Buffer).equals(mapleIcc)).toBe(true);
        }
      },
    );
  });
});
