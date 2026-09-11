import * as path from 'node:path';
import { describe, expect, it, spyOn } from 'bun:test';
import {
  loadNativeBinding,
  findNativeLib,
  maple,
  exportImage,
  exportRecipe,
  getPlatformPackageName,
  getPlatformBinaryFilename,
  isMusl,
  resolvePlatformPackageLib,
} from '../src/index.ts';

const repoRoot = path.resolve(__dirname, '../../..');
const fixturePng = path.join(repoRoot, 'src/apple/MapleUITests/Goldens/.calibration/a.png');
const fixtureDng = path.join(repoRoot, 'test-fixtures/batch-transfer/source.dng');

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
    const pngPath = fixturePng;
    const meta = await maple(pngPath).metadata();
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
    expect(meta.format).toBe('png');
    expect(meta.channels).toBe(3);
    expect(meta.isRaw).toBe(false);
  });

  it('probes RAW DNG metadata with fast TIFF parsing', async () => {
    const dngPath = fixtureDng;
    const meta = await maple(dngPath).metadata();
    expect(meta.width).toBe(96);
    expect(meta.height).toBe(64);
    expect(meta.format).toBe('dng');
    expect(meta.isRaw).toBe(true);
  });

  it('resizes bitmap to file with format transcoding', async () => {
    const pngPath = fixturePng;
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
    const pngPath = fixturePng;
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
    const pngPath = fixturePng;
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
    const pngPath = fixturePng;
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
    const dngPath = fixtureDng;
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
    const pngPath = fixturePng;
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
    const pngPath = fixturePng;
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

  describe('Raster v2 surface', () => {
    const solid = (w: number, h: number, rgb: [number, number, number]) => ({
      data: new Uint8Array(Array.from({ length: w * h }, () => rgb).flat()),
      width: w,
      height: h,
      channels: 3 as const,
    });

    it('accepts raw pixel input and encodes it', async () => {
      const png = await maple(solid(8, 4, [10, 20, 30]))
        .toFormat('png')
        .toBuffer();
      const meta = await maple(png).metadata();
      expect([meta.width, meta.height, meta.format]).toEqual([8, 4, 'png']);
    });

    it('cover fit produces the exact box', async () => {
      const png = await maple(solid(40, 20, [1, 2, 3]))
        .toFormat('png')
        .toBuffer();
      const out = await maple(png)
        .resize({ width: 10, height: 10, fit: 'cover' })
        .toFormat('png')
        .toBuffer();
      const meta = await maple(out).metadata();
      expect([meta.width, meta.height]).toEqual([10, 10]);
    });

    it('toRaw returns native-size RGB8', async () => {
      const png = await maple(solid(6, 5, [90, 90, 90]))
        .toFormat('png')
        .toBuffer();
      const raw = await maple(png).toRaw();
      expect([raw.width, raw.height, raw.channels, raw.data.length]).toEqual([6, 5, 3, 90]);
      expect(raw.data.every((b) => b === 90)).toBe(true);
    });

    it('decodes AVIF for metadata, transcode and integrity', async () => {
      const avif = await maple(solid(24, 16, [200, 50, 50]))
        .toFormat('avif', { quality: 60, effort: 2 })
        .toBuffer();
      const meta = await maple(avif).metadata();
      expect([meta.width, meta.height, meta.format]).toEqual([24, 16, 'avif']);
      const jpeg = await maple(avif).toFormat('jpeg', { quality: 90 }).toBuffer();
      expect(jpeg[0]).toBe(0xff);
      expect(await maple(avif).validateIntegrity()).toBe(true);
      expect(await maple(avif.subarray(0, 40)).validateIntegrity()).toBe(false);
    });

    it('recovers a truncated JPEG', async () => {
      const jpeg = await maple(solid(64, 48, [30, 60, 90]))
        .toFormat('jpeg', { quality: 90 })
        .toBuffer();
      const sos = jpeg.findIndex((b, i) => b === 0xff && jpeg[i + 1] === 0xda);
      const cut = jpeg.subarray(0, sos + Math.floor((jpeg.length - sos) * 0.6));
      const out = await maple(cut).resize(32, 32).toFormat('png').toBuffer();
      const meta = await maple(out).metadata();
      expect([meta.width, meta.height]).toEqual([32, 24]);
    });
  });

  describe('CLI Command Execution', () => {
    it('executes "inspect" subcommand', async () => {
      const { runCli } = await import('../src/cli.ts');
      const pngPath = fixturePng;
      const code = await runCli(['bun', 'maple', 'inspect', pngPath, '--json']);
      expect(code).toBe(0);
    });

    it('executes "resize" subcommand', async () => {
      const { runCli } = await import('../src/cli.ts');
      const pngPath = fixturePng;
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

    it('reports the MAPLE_VERSION constant, which matches package.json', async () => {
      const { runCli } = await import('../src/cli.ts');
      const { MAPLE_VERSION } = await import('../src/version.ts');
      const { readFileSync } = await import('node:fs');
      const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));
      expect(MAPLE_VERSION).toBe(pkg.version);
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(await runCli(['bun', 'maple', 'version'])).toBe(0);
        const printed = log.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(printed).toContain(`maple ${MAPLE_VERSION}`);
      } finally {
        log.mockRestore();
      }
    });

    it('sync-versions.ts rewrites the MAPLE_VERSION constant along with package.json', async () => {
      // The script locates the package relative to its own file, so it runs
      // against a throwaway copy of the package layout, never the workspace.
      const fs = await import('node:fs');
      const os = await import('node:os');
      const { spawnSync } = await import('node:child_process');
      const mapleDir = path.resolve(__dirname, '..');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maple-sync-versions-'));
      try {
        for (const rel of ['package.json', 'src/version.ts', 'scripts/sync-versions.ts']) {
          fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
          fs.copyFileSync(path.join(mapleDir, rel), path.join(tmp, rel));
        }
        const platformDir = path.join(tmp, 'npm', 'darwin-arm64');
        fs.mkdirSync(platformDir, { recursive: true });
        fs.copyFileSync(
          path.join(mapleDir, 'npm', 'darwin-arm64', 'package.json'),
          path.join(platformDir, 'package.json'),
        );

        const res = spawnSync('bun', [path.join(tmp, 'scripts', 'sync-versions.ts'), '9.9.9']);
        expect(res.status).toBe(0);
        expect(fs.readFileSync(path.join(tmp, 'src', 'version.ts'), 'utf-8')).toContain(
          "MAPLE_VERSION = '9.9.9'",
        );
        const root = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
        expect(root.version).toBe('9.9.9');
        expect(root.optionalDependencies['@justmaple/maple-darwin-arm64']).toBe('9.9.9');
        const platform = JSON.parse(
          fs.readFileSync(path.join(platformDir, 'package.json'), 'utf-8'),
        );
        expect(platform.version).toBe('9.9.9');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('returns error code 1 for unknown commands', async () => {
      const { runCli } = await import('../src/cli.ts');
      expect(await runCli(['bun', 'maple', 'unknown-subcommand'])).toBe(1);
    });
  });

  describe('Platform Package Resolution & Packaging', () => {
    it('detects platform package name accurately across operating systems', () => {
      expect(getPlatformPackageName('darwin', 'arm64')).toBe('@justmaple/maple-darwin-arm64');
      expect(getPlatformPackageName('darwin', 'x64')).toBe('@justmaple/maple-darwin-x64');
      expect(getPlatformPackageName('linux', 'x64', false)).toBe('@justmaple/maple-linux-x64-gnu');
      expect(getPlatformPackageName('linux', 'x64', true)).toBe('@justmaple/maple-linux-x64-musl');
      expect(getPlatformPackageName('linux', 'arm64', false)).toBe(
        '@justmaple/maple-linux-arm64-gnu',
      );
      expect(getPlatformPackageName('linux', 'arm64', true)).toBe(
        '@justmaple/maple-linux-arm64-musl',
      );
      expect(getPlatformPackageName('win32', 'x64')).toBe('@justmaple/maple-win32-x64-msvc');
      expect(getPlatformPackageName('freebsd' as any, 'x64')).toBeNull();
    });

    it('determines platform library filename correctly', () => {
      expect(getPlatformBinaryFilename('win32')).toBe('raw_ffi.dll');
      expect(getPlatformBinaryFilename('darwin')).toBe('libraw_ffi.dylib');
      expect(getPlatformBinaryFilename('linux')).toBe('libraw_ffi.so');
    });

    it('evaluates isMusl without throwing', () => {
      const res = isMusl();
      expect(typeof res).toBe('boolean');
    });

    it('isMusl returns false when runtime glibc is present even if musl is installed', () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      const originalReport = (process as unknown as { report?: unknown }).report;

      try {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        (process as unknown as { report?: unknown }).report = {
          getReport: () => ({ header: { glibcVersionRuntime: '2.36' } }),
        };

        expect(isMusl()).toBe(false);
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, 'platform', originalPlatform);
        }
        (process as unknown as { report?: unknown }).report = originalReport;
      }
    });

    it('evaluates resolvePlatformPackageLib safely', () => {
      const res = resolvePlatformPackageLib();
      expect(res === null || typeof res === 'string').toBe(true);
    });

    it('contains valid manifest structure in all 7 npm platform packages', async () => {
      const { readdirSync, readFileSync, existsSync } = await import('node:fs');
      const { resolve, join } = await import('node:path');
      const npmDir = resolve(__dirname, '../npm');
      expect(existsSync(npmDir)).toBe(true);

      const dirs = readdirSync(npmDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      expect(dirs.length).toBe(7);

      for (const dir of dirs) {
        const pkgJsonPath = join(npmDir, dir, 'package.json');
        expect(existsSync(pkgJsonPath)).toBe(true);
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        expect(pkg.name).toMatch(/^@justmaple\/maple-/);
        expect(pkg.version).toBeDefined();
        expect(pkg.main).toBeDefined();
        expect(pkg.license).toBe('MIT');
        expect(pkg.publishConfig?.access).toBe('public');
      }
    });

    it('executes linkage auditor against non-existent or invalid files with clean failure', async () => {
      const { spawnSync } = await import('node:child_process');
      const { resolve } = await import('node:path');
      const auditScript = resolve(__dirname, '../scripts/audit-linkage.sh');
      const res = spawnSync(auditScript, ['/non/existent/lib.so', 'glibc']);
      expect(res.status).not.toBe(0);
    });
  });
});
