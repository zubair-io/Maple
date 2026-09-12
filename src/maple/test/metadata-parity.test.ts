import * as path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';

/**
 * The #3507 final fix wave: everything whose expected value is "whatever
 * sharp says", measured against a real sharp install rather than pinned
 * from a planning doc.
 *
 * Sibling of `metadata.test.ts`, which owns the shape-of-the-API tests
 * (what `metadata()` reports, what `stats()` computes, which builder calls
 * reject what). Split out under the file-size budget, and because these
 * cases all share one fixture builder: sharp writes the input, so the
 * oracle and the fixture are the same install.
 *
 * Every numeric expectation below is compared against sharp at run time,
 * not hardcoded, so the suite cannot drift from the oracle. The whole
 * describe skips — loudly — when sharp is not installed under `src/api`,
 * mirroring the existing oracle block's pattern.
 */
describe('sharp parity: metadata, orientation and density (#3507)', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const apiDir = path.join(repoRoot, 'src/api');
  let sharpPath: string | null;
  try {
    sharpPath = require.resolve('sharp', { paths: [apiDir] });
  } catch {
    sharpPath = null;
    console.warn('sharp parity tests skipped: no sharp install found under', apiDir);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharp = sharpPath === null ? null : require(sharpPath);
  const skip = sharpPath === null;

  /** 24x16 asymmetric RGB: every one of the eight transforms is distinct. */
  const base = () => {
    const width = 24;
    const height = 16;
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        data[i] = (x * 10 + 3) & 0xff;
        data[i + 1] = (y * 15 + 7) & 0xff;
        data[i + 2] = (x * 3 + y * 5 + 11) & 0xff;
      }
    }
    return { data, width, height, channels: 3 as const };
  };

  const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><!-- parity --></x:xmpmeta>';

  /** One sharp-written container carrying EXIF orientation 6 and XMP. */
  const written = async (format: 'jpeg' | 'png' | 'webp' | 'tiff' | 'avif') => {
    const raw = base();
    const pipeline = sharp(raw.data, { raw }).withMetadata({ orientation: 6 }).withXmp(XMP);
    return (await pipeline.toFormat(format).toBuffer()) as Buffer;
  };

  const CONTAINERS = ['jpeg', 'png', 'webp', 'tiff', 'avif'] as const;

  it.skipIf(skip)('metadata().exif is byte-identical to sharp for every container', async () => {
    // Internally the block is always canonicalised to its TIFF header; what
    // comes back out is the form the container stored it in, because that
    // is what sharp returns — introduced for JPEG/WebP/AVIF, bare for PNG,
    // and absent for TIFF (whose IFD0 is its EXIF).
    for (const format of CONTAINERS) {
      const buf = await written(format);
      const mine = (await maple(buf).metadata()).exif;
      const theirs = (await sharp(buf).metadata()).exif;
      if (theirs === undefined) {
        expect(mine, `${format} exif`).toBeUndefined();
        continue;
      }
      expect(mine, `${format} exif`).toBeDefined();
      expect(mine!.equals(theirs), `${format} exif bytes`).toBe(true);
    }
  });

  it.skipIf(skip)('metadata().xmp is byte-identical to sharp for every container', async () => {
    // PNG is the one that used to come back empty: libvips writes the packet
    // as a `tEXt` chunk, not the `iTXt` this package's own encoder writes.
    for (const format of CONTAINERS) {
      const buf = await written(format);
      const mine = (await maple(buf).metadata()).xmp;
      const theirs = (await sharp(buf).metadata()).xmp;
      expect(mine, `${format} xmp`).toBeDefined();
      expect(mine!.equals(theirs as Buffer), `${format} xmp bytes`).toBe(true);
    }
  });

  it.skipIf(skip)('metadata().orientation matches sharp for every container', async () => {
    for (const format of CONTAINERS) {
      const buf = await written(format);
      const theirs = (await sharp(buf).metadata()).orientation;
      // AVIF included: libvips surfaces no orientation at all for a
      // HEIF-family file — measured `undefined` even for one whose `Exif`
      // item says 6 — and Maple now reports `undefined` too (#3507 round
      // 3). Its transform is in the pixels; see the cases below.
      expect((await maple(buf).metadata()).orientation, `${format} orientation`).toBe(theirs);
    }
  });

  it.skipIf(skip)('default output matches sharp pixel for pixel, transforms included', async () => {
    // An AVIF's `irot`/`imir` is applied to the pixels by libheif while it
    // decodes, so it has to be baked in here too or the default output
    // differs from sharp's by a rotation (#3507 round 2).
    //
    // Dimensions are compared exactly; pixels within a tolerance, since
    // JPEG and AVIF are lossy and the two libraries' decoders are not the
    // same code. The tolerance is nowhere near loose enough to hide a wrong
    // transform: on this fixture the mean absolute difference between the
    // right transform and the next-best one is 52.
    for (const format of CONTAINERS) {
      // sharp's `.tiff()` defaults to JPEG-in-TIFF (YCbCr), which the
      // `image` crate's TIFF decoder refuses outright ("Unhandled TIFF
      // color type YCbCr(8)") — a decode gap unrelated to orientation.
      if (format === 'tiff') continue;
      const buf = await written(format);
      const mine = await maple(buf).toRaw();
      const theirs = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      expect([mine.width, mine.height], `${format} raw dimensions`).toEqual([
        theirs.info.width,
        theirs.info.height,
      ]);
      const a = Buffer.from(mine.data);
      const b = Buffer.from(theirs.data);
      expect(a.length, `${format} raw length`).toBe(b.length);
      const error = a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
      expect(error, `${format} mean absolute pixel difference`).toBeLessThan(12);
    }
  });

  it.skipIf(skip)(
    'an AVIF Exif Orientation is readable in the exif block, not surfaced',
    async () => {
      // #3586 closes as "matches sharp": the container transform is baked
      // into the pixels and the `Exif` item's Orientation tag is not
      // surfaced, exactly as libvips does it. The tag is still there to read
      // out of the block, for a caller who wants it.
      const raw = base();
      const src = await sharp(raw.data, { raw }).png().toBuffer();
      const avif = await maple(src).withMetadata({ orientation: 5 }).avif().toBuffer();
      const mine = await maple(avif).metadata();
      expect(mine.orientation).toBeUndefined();
      expect((await sharp(avif).metadata()).orientation).toBeUndefined();
      // Little-endian IFD0 with Orientation as its only entry — the block
      // `set_exif_orientation` builds, at offset 18 past any introducer.
      const block = mine.exif!;
      const tiff =
        block.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? block.subarray(6) : block;
      expect(tiff.readUInt16LE(18)).toBe(5);
    },
  );

  it.skipIf(skip)('.rotate() honours the container orientation like sharp', async () => {
    // The defect this PR set out to fix: only JPEG used to rotate. AVIF is
    // included, and is a no-op on both sides — its transform is already in
    // the pixels and its `Exif` Orientation is not surfaced (#3507 round 3).
    for (const format of CONTAINERS) {
      if (format === 'tiff') continue; // no .tiff() sugar on the builder yet
      const buf = await written(format);
      const mine = await maple(buf).rotate().png().toBuffer();
      const theirs = await sharp(buf).rotate().png().toBuffer();
      const mineMeta = await maple(mine).metadata();
      const theirsMeta = await sharp(theirs).metadata();
      expect([mineMeta.width, mineMeta.height], `${format} rotate() dimensions`).toEqual([
        theirsMeta.width,
        theirsMeta.height,
      ]);
    }
  });

  it.skipIf(skip)('metadata() reports an AVIF post-transform, as libheif does', async () => {
    const buf = await written('avif');
    const mine = await maple(buf).metadata();
    const theirs = await sharp(buf).metadata();
    expect([mine.width, mine.height]).toEqual([theirs.width, theirs.height]);
    // libvips wrote this file's orientation into BOTH the `irot` box and
    // the `Exif` item. The box is baked into the pixels; the tag is not
    // surfaced, which is why `.rotate()` cannot rotate it a second time.
    expect(mine.orientation).toBeUndefined();
    expect(theirs.orientation).toBeUndefined();
  });

  it.skipIf(skip)('metadata().density matches sharp across containers and values', async () => {
    for (const density of [26, 25.4, 72, 96, 300]) {
      for (const format of CONTAINERS) {
        const raw = base();
        const buf = await sharp(raw.data, { raw })
          .withMetadata({ density })
          .toFormat(format)
          .toBuffer();
        const mine = (await maple(buf).metadata()).density;
        const theirs = (await sharp(buf).metadata()).density;
        expect(mine ?? null, `${format} @${density} dpi`).toBe(theirs ?? null);
      }
    }
  });

  it.skipIf(skip)('a cross-container keepMetadata() writes EXIF sharp can read', async () => {
    // A WebP or AVIF source stores the block behind the `Exif\0\0`
    // introducer a JPEG encoder adds for itself, so keeping one used to
    // write a doubly-introduced block sharp read as `orientation:
    // undefined`.
    for (const format of ['webp', 'png'] as const) {
      const buf = await written(format);
      const out = await maple(buf).keepMetadata().jpeg().toBuffer();
      const mine = await sharp(out).metadata();
      const theirs = await sharp(await sharp(buf).keepMetadata().jpeg().toBuffer()).metadata();
      expect(mine.orientation, `${format} -> jpeg orientation`).toBe(theirs.orientation);
      expect(mine.exif!.length, `${format} -> jpeg exif length`).toBe(theirs.exif!.length);
    }
  });

  it.skipIf(skip)(
    'keepMetadata() and withMetadata({orientation}) never fail a container',
    async () => {
      // Only a field named by withExif/withIccProfile/withXmp/withMetadata
      // ({density}) can error; a keep-swept field a container cannot carry is
      // dropped silently, as sharp does.
      const buf = await written('jpeg');
      for (const format of CONTAINERS) {
        const kept = await maple(buf).keepMetadata().toFormat(format).toBuffer();
        expect(kept.length, `keep -> ${format}`).toBeGreaterThan(0);
        const oriented = await maple(buf)
          .keepMetadata()
          .withMetadata({ orientation: 5 })
          .toFormat(format)
          .toBuffer();
        expect(oriented.length, `keep+orientation -> ${format}`).toBeGreaterThan(0);
      }
    },
  );

  it.skipIf(skip)('withMetadata({density}) survives a kept EXIF resolution', async () => {
    // libvips prefers the EXIF resolution over the JFIF/pHYs one, so a
    // density written only into the container's own field lost to the kept
    // block: sharp read 96 back off a 300 dpi request.
    const raw = base();
    const source = await sharp(raw.data, { raw })
      .withMetadata({ orientation: 6, density: 96 })
      .jpeg()
      .toBuffer();
    for (const format of ['jpeg', 'png'] as const) {
      const out = await maple(source)
        .keepMetadata()
        .withMetadata({ density: 300 })
        .toFormat(format)
        .toBuffer();
      const theirs = await sharp(
        await sharp(source)
          .keepMetadata()
          .withMetadata({ density: 300 })
          .toFormat(format)
          .toBuffer(),
      ).metadata();
      expect((await sharp(out).metadata()).density, `${format} density`).toBe(theirs.density);
    }
  });

  describe('argument and input guards', () => {
    it('withXmp() rejects a non-string with sharp exact wording', () => {
      const cases: [unknown, string][] = [
        [42, 'Expected non-empty string for xmp but received 42 of type number'],
        [null, 'Expected non-empty string for xmp but received null of type object'],
        [undefined, 'Expected non-empty string for xmp but received undefined of type undefined'],
        [{}, 'Expected non-empty string for xmp but received [object Object] of type object'],
        ['', 'Expected non-empty string for xmp but received  of type string'],
        [Buffer.alloc(0), 'Expected non-empty string for xmp but received  of type object'],
      ];
      for (const [value, message] of cases) {
        expect(() => maple(Buffer.from([1, 2, 3])).withXmp(value as string)).toThrow(message);
      }
    });

    it('an empty input buffer is rejected up front, with sharp exact wording', async () => {
      // Every FFI wrapper downstream hands the buffer to bun:ffi's ptr(),
      // which leaked `TypeError: bun:ffi cannot convert argument to 'ptr'`.
      expect(() => maple(Buffer.alloc(0))).toThrow('Input Buffer is empty');
      expect(() => maple(new Uint8Array(0))).toThrow('Input Buffer is empty');
    });
  });
});
