import { describe, expect, it } from 'bun:test';
import {
  loadNativeBinding,
  findNativeLib,
  maple,
  exportImage,
  exportRecipe,
} from '../src/index.ts';

describe('Maple Native Binding', () => {
  it('locates the native library', () => {
    const lib = findNativeLib();
    expect(lib).not.toBeNull();
    expect(typeof lib).toBe('string');
  });

  it('loads native binding functions', () => {
    const native = loadNativeBinding();
    expect(typeof native.exportDevelopedToFile).toBe('function');
    expect(typeof native.exportRecipeToFile).toBe('function');
    expect(typeof native.renderThumbnailAvifToFile).toBe('function');
    expect(typeof native.renderFilenameTemplate).toBe('function');
    expect(typeof native.validateFilename).toBe('function');
  });

  it('renders filename template correctly', () => {
    const native = loadNativeBinding();
    const res = native.renderFilenameTemplate({
      template: '{original}_{n}.{ext}',
      originalStem: 'IMG_1234',
      ext: 'jpg',
      capturedAt: '2026:09:09 12:00:00',
      sequenceStart: 1,
      sequenceIndex: 0,
      sequencePadWidth: 3,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.name).toBe('IMG_1234_001.jpg');
    }
  });

  it('validates filenames according to cross-platform rules', () => {
    const native = loadNativeBinding();
    expect(native.validateFilename('valid-photo_01.jpg').ok).toBe(true);
    // Path separators, leading dots, trailing spaces, and Windows reserved names are rejected
    expect(native.validateFilename('path/separator.jpg').ok).toBe(false);
    expect(native.validateFilename('.hidden.jpg').ok).toBe(false);
    expect(native.validateFilename('CON.jpg').ok).toBe(false);
  });

  it('gracefully reports error when exporting non-existent photo', async () => {
    const res = await exportImage({
      rawPath: '/non/existent/photo.dng',
      outPath: '/tmp/out.jpg',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });

  it('fluent builder initializes and chains cleanly', () => {
    const builder = maple('test.dng')
      .format('png')
      .quality(95)
      .colorSpace('display-p3')
      .maxLongEdge(1024);
    expect(builder).toBeDefined();
  });

  it('probes raster image metadata without full decode', async () => {
    const pngPath = '../../src/apple/MapleUITests/Goldens/.calibration/a.png';
    const meta = await maple(pngPath).metadata();
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
    expect(meta.format).toBe('png');
    expect(meta.channels).toBe(3);
    expect(meta.isRaw).toBe(false);
  });

  it('probes RAW DNG metadata with fast TIFF parsing', async () => {
    const dngPath = '../../test-fixtures/batch-transfer/source.dng';
    const meta = await maple(dngPath).metadata();
    expect(meta.width).toBe(96);
    expect(meta.height).toBe(64);
    expect(meta.format).toBe('dng');
    expect(meta.isRaw).toBe(true);
  });

  it('resizes bitmap to file with format transcoding', async () => {
    const pngPath = '../../src/apple/MapleUITests/Goldens/.calibration/a.png';
    const outPath = '/tmp/test_maple_resize.webp';
    const res = await maple(pngPath)
      .resize({ width: 32, height: 32, fit: 'inside' })
      .toFormat('webp', { quality: 80 })
      .toFile(outPath);

    expect(res.ok).toBe(true);
    const meta = await maple(outPath).metadata();
    expect(meta.width).toBe(32);
    expect(meta.height).toBe(32);
    expect(meta.format).toBe('webp');
  });

  it('resizes bitmap directly to an in-memory Buffer', async () => {
    const pngPath = '../../src/apple/MapleUITests/Goldens/.calibration/a.png';
    const buf = await maple(pngPath)
      .resize({ width: 48, height: 48, fit: 'inside' })
      .toFormat('jpeg', { quality: 90 })
      .toBuffer();

    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);

    // Verify JPEG magic bytes [0xFF, 0xD8, 0xFF]
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
    expect(buf[2]).toBe(0xff);

    // Verify probing works directly from the in-memory buffer
    const bufMeta = await maple(buf).metadata();
    expect(bufMeta.width).toBe(48);
    expect(bufMeta.height).toBe(48);
    expect(bufMeta.format).toBe('jpeg');
  });

  it('extracts InsightFace normalized Float32Array tensor for ML inference', async () => {
    const pngPath = '../../src/apple/MapleUITests/Goldens/.calibration/a.png';
    const { data, width, height, channels } = await maple(pngPath)
      .resize(64, 64)
      .toRawRgb({ targetSize: 64, layout: 'nchw', normalize: 'insightface' });

    expect(width).toBe(64);
    expect(height).toBe(64);
    expect(channels).toBe(3);
    expect(data).toBeInstanceOf(Float32Array);
    expect(data.length).toBe(3 * 64 * 64);

    // InsightFace normalization scales [0, 255] -> [-1.0, 1.0] via (px - 127.5) / 128.0
    for (let i = 0; i < 100; i++) {
      expect(data[i]).toBeGreaterThanOrEqual(-1.05);
      expect(data[i]).toBeLessThanOrEqual(1.05);
    }
  });

  it('validates file integrity and normalizes orientation', async () => {
    const pngPath = '../../src/apple/MapleUITests/Goldens/.calibration/a.png';
    const isValid = await maple(pngPath).validateIntegrity();
    expect(isValid).toBe(true);

    const isGarbageValid = await maple(Buffer.from('not an image')).validateIntegrity();
    expect(isGarbageValid).toBe(false);

    // Truncated payload with valid JPEG header
    const truncatedJpg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    ]);
    const isTruncatedValid = await maple(truncatedJpg).validateIntegrity();
    expect(isTruncatedValid).toBe(false);
  });

  it('develops real RAW DNG photo to JPEG with AgX view transform', async () => {
    const dngPath = '../../test-fixtures/batch-transfer/source.dng';
    const outJpg = '/tmp/test_maple_raw_develop.jpg';
    const res = await maple(dngPath).format('jpeg').quality(92).colorSpace('srgb').toFile(outJpg);

    expect(res.ok).toBe(true);
    const meta = await maple(outJpg).metadata();
    expect(meta.width).toBe(96);
    expect(meta.height).toBe(64);
    expect(meta.format).toBe('jpeg');
    expect(meta.isRaw).toBe(false);
  });

  it('extracts HWC layout tensor with zeroToOne normalization', async () => {
    const pngPath = '../../src/apple/MapleUITests/Goldens/.calibration/a.png';
    const { data, width, height } = await maple(pngPath)
      .resize(32, 32)
      .toRawRgb({ targetSize: 32, layout: 'hwc', normalize: 'zeroToOne' });

    expect(width).toBe(32);
    expect(height).toBe(32);
    expect(data.length).toBe(3 * 32 * 32);
    for (let i = 0; i < 50; i++) {
      expect(data[i]).toBeGreaterThanOrEqual(0.0);
      expect(data[i]).toBeLessThanOrEqual(1.0);
    }
  });

  it('transcodes in-memory buffers across multiple formats', async () => {
    const pngPath = '../../src/apple/MapleUITests/Goldens/.calibration/a.png';
    const pngBytes = await Bun.file(pngPath).arrayBuffer();

    // PNG -> WebP in-memory
    const webpBuf = await maple(new Uint8Array(pngBytes))
      .resize({ width: 32, height: 32 })
      .toFormat('webp')
      .toBuffer();
    expect(webpBuf.length).toBeGreaterThan(0);
    const webpMeta = await maple(webpBuf).metadata();
    expect(webpMeta.format).toBe('webp');
    expect(webpMeta.width).toBe(32);

    // WebP -> JPEG in-memory
    const jpegBuf = await maple(webpBuf).toFormat('jpeg', { quality: 85 }).toBuffer();
    expect(jpegBuf.length).toBeGreaterThan(0);
    const jpegMeta = await maple(jpegBuf).metadata();
    expect(jpegMeta.format).toBe('jpeg');
  });

  describe('CLI Command Execution', () => {
    it('executes "inspect" subcommand', async () => {
      const { runCli } = await import('../src/cli.ts');
      const pngPath = '../../src/apple/MapleUITests/Goldens/.calibration/a.png';
      const code = await runCli(['bun', 'maple', 'inspect', pngPath, '--json']);
      expect(code).toBe(0);
    });

    it('executes "resize" subcommand', async () => {
      const { runCli } = await import('../src/cli.ts');
      const pngPath = '../../src/apple/MapleUITests/Goldens/.calibration/a.png';
      const outPath = '/tmp/cli_resize_test.webp';
      const code = await runCli([
        'bun',
        'maple',
        'resize',
        pngPath,
        '-o',
        outPath,
        '-w',
        '32',
        '-h',
        '32',
        '-f',
        'webp',
      ]);
      expect(code).toBe(0);
      const meta = await maple(outPath).metadata();
      expect(meta.width).toBe(32);
      expect(meta.format).toBe('webp');
    });

    it('executes "help" and "version" subcommands', async () => {
      const { runCli } = await import('../src/cli.ts');
      expect(await runCli(['bun', 'maple', 'help'])).toBe(0);
      expect(await runCli(['bun', 'maple', '--version'])).toBe(0);
    });

    it('returns error code 1 for unknown commands', async () => {
      const { runCli } = await import('../src/cli.ts');
      expect(await runCli(['bun', 'maple', 'unknown-subcommand'])).toBe(1);
    });
  });
});
