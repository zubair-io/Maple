/**
 * End-to-end: the `.maple/` derived cache reaches the library's mirror.
 *
 * Thumb and preview bytes are written OUT-OF-BAND — an FFI worker or the
 * imgdecode child process writes straight to the path — so the mirror-aware fs
 * drop-in cannot intercept them. `generateThumb` / `generatePreview` therefore
 * call `replicatePath` once their validate-then-publish rename commits, and
 * this test renders a real image through the real pipeline and asserts the
 * bytes landed on the mirror (#926).
 *
 * Soft-passes when the host can't render (no imgdecode child / codec), matching
 * the repo's fixture-gated convention — the assertion is only meaningful if a
 * thumb actually appeared on the primary.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import realFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { setMirrorRoots, clearMirrorRoots } from '../fs/mirror-registry.ts';
import { flushPendingMirrorOps } from '../fs/mirrored.ts';
import { resolveThumbPath, cachePathFor } from '../fs/xmp.ts';
import { generateThumb } from './thumbnailer.ts';
import { generatePreview, PREVIEW_CACHE_SUFFIX } from './previewer.ts';

let dir: string;
let primary: string;
let mirror: string;
let source: string;

beforeEach(async () => {
  dir = await realFs.realpath(await realFs.mkdtemp(path.join(os.tmpdir(), 'maple-cache-mirror-')));
  primary = path.join(dir, 'primary');
  mirror = path.join(dir, 'mirror');
  await realFs.mkdir(primary, { recursive: true });
  await realFs.mkdir(mirror, { recursive: true });
  setMirrorRoots({ [primary]: [mirror] });

  source = path.join(primary, 'photo.jpg');
  const bytes = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } },
  })
    .jpeg()
    .toBuffer();
  await realFs.writeFile(source, bytes);
});

afterEach(async () => {
  clearMirrorRoots();
  await realFs.rm(dir, { recursive: true, force: true });
});

/** Same bytes on both sides, or fail with which side is wrong. */
async function expectReplicated(primaryPath: string): Promise<void> {
  const rel = path.relative(primary, primaryPath);
  const mirrorPath = path.join(mirror, rel);
  const [a, b] = await Promise.all([realFs.readFile(primaryPath), realFs.readFile(mirrorPath)]);
  expect(b.byteLength).toBe(a.byteLength);
  expect(Buffer.compare(a, b)).toBe(0);
}

describe('.maple cache replication', () => {
  test('a rendered thumbnail lands on the mirror', async () => {
    const thumbPath = resolveThumbPath(source);
    await generateThumb(source, thumbPath);
    await flushPendingMirrorOps();

    const rendered = await realFs.stat(thumbPath).catch(() => null);
    if (rendered === null) return; // soft pass: this host can't encode AVIF
    await expectReplicated(thumbPath);
  });

  test('a rendered preview lands on the mirror', async () => {
    const previewPath = cachePathFor(source, 'previews', PREVIEW_CACHE_SUFFIX);
    await generatePreview(source, previewPath);
    await flushPendingMirrorOps();

    const rendered = await realFs.stat(previewPath).catch(() => null);
    if (rendered === null) return; // soft pass: this host can't encode AVIF
    await expectReplicated(previewPath);
  });

  test('nothing is replicated for a source that produces no thumb', async () => {
    // Audio has no still frame — `generateThumb` bails before any render, so
    // the mirror must not gain a file either.
    const audio = path.join(primary, 'memo.m4a');
    await realFs.writeFile(audio, 'not a real m4a file');
    const thumbPath = resolveThumbPath(audio);
    await generateThumb(audio, thumbPath);
    await flushPendingMirrorOps();

    const rel = path.relative(primary, thumbPath);
    await expect(realFs.stat(path.join(mirror, rel))).rejects.toThrow();
  });
});
