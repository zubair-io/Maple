// fs-thumbs.video.test.ts
//
// GET /api/fs/thumb for video containers (#2132).
//
// The regression this exists to prevent: #1649 taught the render paths to
// extract poster frames, but `/api/fs/thumb` gates on a positive allowlist in
// `fs-jail.ts` that never mentioned video, so every request 415'd at the
// extension check before any render was attempted. The denylist rename in
// #1649 forced a compile error at each site that had an opinion about video —
// an allowlist that simply omitted it could not be caught that way, which is
// why these cases are pinned explicitly.
//
// Split from `fs-thumbs.etag.test.ts` rather than appended: that file is not
// prettier-clean under the repo config, so touching it would drag an unrelated
// reformat into the diff.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, writeFile, realpath, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { fsThumbsRoutes } from './fs-thumbs.ts';
import * as videoPosterModule from '../thumbs/video-poster.ts';

/** Synthesize a real video via the host ffmpeg. Null when unavailable, which
 * gates the decode-dependent cases — same skip-pass convention as the color
 * harness and `video-poster.test.ts`. */
async function makeTestVideo(bin: string, out: string): Promise<string | null> {
  const proc = Bun.spawn(
    [
      bin,
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=640x360:rate=10',
      '-pix_fmt',
      'yuv420p',
      '-y',
      out,
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  return (await proc.exited) === 0 ? out : null;
}

function get(p: string): Promise<Response> {
  const app = new Elysia().use(fsThumbsRoutes);
  return app.handle(
    new Request(`http://localhost/api/fs/thumb?path=${encodeURIComponent(p)}&size=512`),
  );
}

describe('GET /api/fs/thumb — video', () => {
  let tmp: string | null = null;

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-fs-thumb-video-')));
    process.env.MAPLE_ROOTS = tmp;
  });

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    tmp = null;
  });

  it('no longer 415s a .MOV at the extension gate', async () => {
    // The exact reported symptom. Deliberately asserts "not 415" rather than a
    // specific success status: without a decoder the correct answer is 503,
    // and either way the request must get PAST the jail.
    const p = join(tmp!, 'IMG_3113.MOV');
    await writeFile(p, Buffer.from('not a real container'));
    const res = await get(p);
    expect(res.status).not.toBe(415);
  });

  it('still 415s a genuinely unsupported extension', async () => {
    // The allowlist must not have been widened into a pass-through.
    const p = join(tmp!, 'notes.txt');
    await writeFile(p, 'hello');
    const res = await get(p);
    expect(res.status).toBe(415);
  });

  it('503s (not 500) when the host has no ffmpeg', async () => {
    // A missing dependency the operator can install is not a server fault.
    // Mirrors the existing "FFI not built" 503 on the RAW branch.
    const spy = spyOn(videoPosterModule, 'ffmpegBinary').mockResolvedValue(null);
    try {
      const p = join(tmp!, 'clip.mp4');
      await writeFile(p, Buffer.from('container bytes'));
      const res = await get(p);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toMatch(/ffmpeg/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('500s on a corrupt container when ffmpeg IS available', async () => {
    const spy = spyOn(videoPosterModule, 'ffmpegBinary').mockResolvedValue('/usr/bin/ffmpeg');
    const extract = spyOn(videoPosterModule, 'extractVideoPosterJpeg').mockResolvedValue(false);
    try {
      const p = join(tmp!, 'broken.mov');
      await writeFile(p, Buffer.from('truncated'));
      const res = await get(p);
      expect(res.status).toBe(500);
    } finally {
      extract.mockRestore();
      spy.mockRestore();
    }
  });

  it('serves a decodable AVIF poster for a real video', async () => {
    const bin = await videoPosterModule.ffmpegBinary();
    if (!bin) return; // gated: no runnable ffmpeg on this host
    const video = await makeTestVideo(bin, join(tmp!, 'real.mp4'));
    if (!video) return;

    const res = await get(video);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/avif');

    // Decode-verified, not merely non-empty: serving undecodable bytes under
    // `image/avif` is the exact failure mode the thumb caches guard against.
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.format).toBe('heif');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(512);
  });

  it('serves the exact reported request shape: uppercase .MOV under spaced directories', async () => {
    const bin = await videoPosterModule.ffmpegBinary();
    if (!bin) return; // gated
    // Reproduces the URL from the #2132 report verbatim in shape —
    // `/2026/New York/New Scotland/IMG_3113.MOV` — because the spaces and the
    // uppercase extension both pass through query decoding and the
    // case-insensitive extension match on the way to the jail.
    const dir = join(tmp!, '2026', 'New York', 'New Scotland');
    await mkdir(dir, { recursive: true });
    const video = await makeTestVideo(bin, join(dir, 'IMG_3113.MOV'));
    if (!video) return;

    const res = await get(video);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/avif');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.format).toBe('heif');
  });

  it('leaves no intermediate poster JPEG in the thumb cache dir', async () => {
    const bin = await videoPosterModule.ffmpegBinary();
    if (!bin) return; // gated
    const video = await makeTestVideo(bin, join(tmp!, 'clean.mp4'));
    if (!video) return;

    expect((await get(video)).status).toBe(200);

    const cacheDir = join(tmp!, '.maple', 'thumbs');
    const entries = await readdir(cacheDir).catch(() => [] as string[]);
    expect(entries.filter((f) => f.includes('.poster.'))).toEqual([]);
  });
});
