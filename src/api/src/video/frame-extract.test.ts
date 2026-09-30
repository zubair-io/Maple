import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { NativeBindingError, maple } from 'maple';
import { extractFramesJpeg, isNativeLoadFailure } from './frame-extract.ts';
import { ffmpegBinary } from '../thumbs/video-poster.ts';
import { MODEL_FRAME_MAX_DIMENSION } from './constants.ts';

describe('isNativeLoadFailure', () => {
  it('recognises the "library not found" message shape', () => {
    const err = new Error(
      'Maple native library (libmaple_core.dylib) not found. Build it with cargo build --release -p raw-ffi or set MAPLE_NATIVE_LIB.',
    );
    expect(isNativeLoadFailure(err)).toBe(true);
  });

  it('recognises the "requires Bun" message shape', () => {
    const err = new Error('Maple native bindings currently require Bun (bun:ffi).');
    expect(isNativeLoadFailure(err)).toBe(true);
  });

  it('returns false for an unrelated Error message (a real decode failure)', () => {
    const err = new Error('unsupported image format');
    expect(isNativeLoadFailure(err)).toBe(false);
  });

  it('returns false for a non-Error thrown value', () => {
    expect(isNativeLoadFailure('some string')).toBe(false);
    expect(isNativeLoadFailure(null)).toBe(false);
    expect(isNativeLoadFailure(undefined)).toBe(false);
  });
});

it('recognises typed loader/ABI failures without relying on their message', () => {
  expect(isNativeLoadFailure(new NativeBindingError('dlopen: wrong architecture'))).toBe(true);
  expect(isNativeLoadFailure(new Error('dlopen: wrong architecture'))).toBe(false);
});

const ffmpeg = await ffmpegBinary();
if (!ffmpeg) console.warn('frame extraction integration: ffmpeg unavailable, skipping');

async function createClip(file: string, width: number, height: number): Promise<void> {
  const proc = Bun.spawn(
    [
      ffmpeg!,
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${width}x${height}:rate=4:duration=2`,
      '-c:v',
      'mpeg4',
      '-q:v',
      '2',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-y',
      file,
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  );
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited, stderr).toBe(0);
}

async function temporaryFrames(): Promise<string[]> {
  return (await fs.readdir(tmpdir()))
    .filter((file) => file.startsWith(`maple-frame-${process.pid}-`))
    .sort();
}

it.skipIf(!ffmpeg)(
  'extracts timestamped, decodable bounded JPEGs and cleans its temporary files',
  async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'maple-frame-extract-test-'));
    try {
      const source = path.join(dir, 'wide.mp4');
      await createClip(source, 1600, 900);
      const original = await fs.readFile(source);
      const modified = (await fs.stat(source)).mtimeMs;
      const before = await temporaryFrames();
      const timestamps = [0, 0.5, 1.25];
      const frames = await extractFramesJpeg(source, timestamps);
      expect(frames.map((frame) => frame.timestampSec)).toEqual(timestamps);
      for (const frame of frames) {
        expect(frame.jpeg.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
        const metadata = await maple(frame.jpeg).metadata();
        expect(metadata.format).toBe('jpeg');
        expect(metadata.width).toBe(MODEL_FRAME_MAX_DIMENSION);
        expect(metadata.height).toBe(432);
        const pixels = await maple(frame.jpeg).toRaw();
        expect(pixels.width).toBe(metadata.width);
        expect(pixels.height).toBe(metadata.height);
        expect(pixels.data.length).toBe(metadata.width * metadata.height * 3);
        expect(new Set(pixels.data).size).toBeGreaterThan(100);
      }
      expect(await temporaryFrames()).toEqual(before);
      expect((await fs.readFile(source)).equals(original)).toBe(true);
      expect((await fs.stat(source)).mtimeMs).toBe(modified);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

it.skipIf(!ffmpeg)(
  'keeps small frames at native size and drops unreadable clips cleanly',
  async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'maple-small-frames-test-'));
    try {
      const source = path.join(dir, 'small.mp4');
      await createClip(source, 64, 48);
      const [frame] = await extractFramesJpeg(source, [0.25]);
      expect(frame).toBeDefined();
      expect(await maple(frame.jpeg).metadata()).toMatchObject({
        format: 'jpeg',
        width: 64,
        height: 48,
      });
      expect(await extractFramesJpeg(source, [])).toEqual([]);
      expect(await extractFramesJpeg(path.join(dir, 'missing.mp4'), [0])).toEqual([]);
      const corrupt = path.join(dir, 'corrupt.mp4');
      await fs.writeFile(corrupt, 'invalid video bytes');
      const before = await temporaryFrames();
      expect(await extractFramesJpeg(corrupt, [0, 0.5])).toEqual([]);
      expect(await temporaryFrames()).toEqual(before);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

it.skipIf(!ffmpeg)(
  'rethrows a real native loader failure and cleans the extracted intermediate',
  async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'maple-frame-backend-test-'));
    try {
      const source = path.join(dir, 'small.mp4');
      await createClip(source, 64, 48);
      const invalidLibrary = path.join(dir, 'invalid-library');
      await fs.writeFile(invalidLibrary, 'invalid native binary');
      const script = `
      import fs from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { isNativeBindingError, shutdownMaplePool } from 'maple';
      import { extractFramesJpeg } from './src/video/frame-extract.ts';
      const remaining = async () => (await fs.readdir(tmpdir()))
        .filter((file) => file.startsWith('maple-frame-' + process.pid + '-'));
      const before = await remaining();
      try {
        await extractFramesJpeg(${JSON.stringify(source)}, [0, 0.5]);
        throw new Error('unexpected successful extraction');
      } catch (error) {
        console.log('MAPLE_FRAME_BACKEND ' + JSON.stringify({ typed: isNativeBindingError(error),
          code: error.code, clean: JSON.stringify(await remaining()) === JSON.stringify(before) }));
      } finally { shutdownMaplePool(); }
    `;
      const proc = Bun.spawn([process.execPath, '-e', script], {
        cwd: path.resolve(import.meta.dir, '../..'),
        env: { ...process.env, MAPLE_NATIVE_LIB: invalidLibrary, MAPLE_NAPI: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exit, stderr).toBe(0);
      const line = stdout.split('\n').find((s) => s.startsWith('MAPLE_FRAME_BACKEND '));
      expect(line, stdout + stderr).toBeDefined();
      expect(JSON.parse(line!.slice('MAPLE_FRAME_BACKEND '.length))).toEqual({
        typed: true,
        code: 'MAPLE_NATIVE_BINDING',
        clean: true,
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
