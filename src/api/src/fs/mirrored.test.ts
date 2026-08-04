/**
 * mirrored.ts + mirror-registry.ts integration tests — real temp dirs, no Mongo.
 *
 * Validates the drop-in fan-out: durable writes/moves/deletes under a primary
 * library root replicate to the configured mirror root, temp files and
 * out-of-root paths do NOT, and a mirror failure never breaks the primary op.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import realFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as fs from './mirrored.ts';
import {
  setMirrorRoots,
  clearMirrorRoots,
  resolveMirrorTargets,
  isMirroringActive,
} from './mirror-registry.ts';

let dir: string;
let primary: string;
let mirror: string;

beforeEach(async () => {
  dir = await realFs.mkdtemp(path.join(os.tmpdir(), 'maple-mirror-'));
  primary = path.join(dir, 'primary');
  mirror = path.join(dir, 'mirror');
  await realFs.mkdir(primary, { recursive: true });
  await realFs.mkdir(mirror, { recursive: true });
  setMirrorRoots({ [primary]: [mirror] });
});

afterEach(async () => {
  clearMirrorRoots();
  await realFs.rm(dir, { recursive: true, force: true });
});

const onMirror = (rel: string) => path.join(mirror, rel);
const onPrimary = (rel: string) => path.join(primary, rel);

describe('mirror-registry', () => {
  test('resolves a path under the primary root to the mirror', () => {
    expect(isMirroringActive()).toBe(true);
    const targets = resolveMirrorTargets(onPrimary('a/b/IMG.dng'));
    expect(targets).toHaveLength(1);
    expect(targets[0]!.mirrorPath).toBe(onMirror('a/b/IMG.dng'));
  });

  test('returns no targets for paths outside any primary root', () => {
    expect(resolveMirrorTargets('/tmp/elsewhere/IMG.dng')).toHaveLength(0);
  });

  test('longest-prefix wins when roots nest', () => {
    const nested = path.join(primary, 'sub');
    const nestedMirror = path.join(dir, 'nested-mirror');
    setMirrorRoots({ [primary]: [mirror], [nested]: [nestedMirror] });
    const targets = resolveMirrorTargets(path.join(nested, 'x.dng'));
    expect(targets).toHaveLength(1);
    expect(targets[0]!.mirrorPath).toBe(path.join(nestedMirror, 'x.dng'));
  });
});

describe('mirrored fs fan-out', () => {
  test('rename (temp → final) publishes to both primary and mirror', async () => {
    const tmp = onPrimary('IMG.dng.tmp.123');
    await realFs.writeFile(tmp, 'raw-bytes');
    await fs.rename(tmp, onPrimary('IMG.dng'));
    await fs.flushPendingMirrorOps();

    expect(await realFs.readFile(onPrimary('IMG.dng'), 'utf8')).toBe('raw-bytes');
    expect(await realFs.readFile(onMirror('IMG.dng'), 'utf8')).toBe('raw-bytes');
  });

  test('copyFile replicates and creates mirror parent dirs', async () => {
    const src = path.join(dir, 'source.dng');
    await realFs.writeFile(src, 'copy-me');
    // Primary parent exists (call sites mkdir it); the mirror parent does not —
    // replicateFile must create it.
    await realFs.mkdir(onPrimary('2024/03'), { recursive: true });
    await fs.copyFile(src, onPrimary('2024/03/IMG.dng'));
    await fs.flushPendingMirrorOps();

    expect(await realFs.readFile(onMirror('2024/03/IMG.dng'), 'utf8')).toBe('copy-me');
  });

  test('temp-file writes are NOT mirrored; the committing rename is', async () => {
    const tmp = onPrimary('sidecar.xmp.tmp.999');
    // Even if some path wrote a temp via the mirrored copyFile, it must be skipped.
    const src = path.join(dir, 's.xmp');
    await realFs.writeFile(src, '<xmp/>');
    await fs.copyFile(src, tmp);
    await fs.flushPendingMirrorOps();
    expect(await fileExists(onMirror('sidecar.xmp.tmp.999'))).toBe(false);

    await fs.rename(tmp, onPrimary('sidecar.xmp'));
    await fs.flushPendingMirrorOps();
    expect(await realFs.readFile(onMirror('sidecar.xmp'), 'utf8')).toBe('<xmp/>');
    expect(await fileExists(onMirror('sidecar.xmp.tmp.999'))).toBe(false);
  });

  test('replicatePath copies an out-of-band write to the mirror', async () => {
    // The `.maple/` cache case: an FFI worker / child process wrote these bytes
    // straight to disk, so no fs verb here saw them. The renderer hands the
    // committed path over explicitly.
    const thumb = onPrimary('.maple/thumbs/abc123.avif');
    await realFs.mkdir(path.dirname(thumb), { recursive: true });
    await realFs.writeFile(thumb, 'avif-bytes');

    fs.replicatePath(thumb);
    await fs.flushPendingMirrorOps();

    expect(await realFs.readFile(onMirror('.maple/thumbs/abc123.avif'), 'utf8')).toBe('avif-bytes');
  });

  test('replicatePath preserves the source mtime on the mirror copy', async () => {
    const thumb = onPrimary('.maple/previews/photo.jpg.avif');
    await realFs.mkdir(path.dirname(thumb), { recursive: true });
    await realFs.writeFile(thumb, 'avif-bytes');
    const past = new Date(Date.now() - 3_600_000);
    await realFs.utimes(thumb, past, past);

    fs.replicatePath(thumb);
    await fs.flushPendingMirrorOps();

    const [a, b] = await Promise.all([
      realFs.stat(thumb),
      realFs.stat(onMirror('.maple/previews/photo.jpg.avif')),
    ]);
    // Faithful mtime is what makes the copy usable as a read replica.
    expect(Math.floor(b.mtimeMs)).toBe(Math.floor(a.mtimeMs));
  });

  test('replicatePath ignores temps and paths outside a mirrored root', async () => {
    const tmp = onPrimary('.maple/thumbs/abc.avif.tmp.42');
    await realFs.mkdir(path.dirname(tmp), { recursive: true });
    await realFs.writeFile(tmp, 'partial');
    fs.replicatePath(tmp);

    const outside = path.join(dir, 'elsewhere.avif');
    await realFs.writeFile(outside, 'unrelated');
    fs.replicatePath(outside);

    await fs.flushPendingMirrorOps();
    expect(await fileExists(onMirror('.maple/thumbs/abc.avif.tmp.42'))).toBe(false);
    expect(await fileExists(path.join(mirror, 'elsewhere.avif'))).toBe(false);
  });

  test('unlinking a cache file removes it from the mirror (cache-gc path)', async () => {
    const thumb = onPrimary('.maple/thumbs/dead.avif');
    await realFs.mkdir(path.dirname(thumb), { recursive: true });
    await realFs.writeFile(thumb, 'avif-bytes');
    fs.replicatePath(thumb);
    await fs.flushPendingMirrorOps();
    expect(await fileExists(onMirror('.maple/thumbs/dead.avif'))).toBe(true);

    // `cache-gc.ts` reclaims orphans through this same mirrored `unlink`.
    await fs.unlink(thumb);
    await fs.flushPendingMirrorOps();
    expect(await fileExists(onMirror('.maple/thumbs/dead.avif'))).toBe(false);
  });

  test('unlink removes the file from the mirror too', async () => {
    const src = path.join(dir, 's.dng');
    await realFs.writeFile(src, 'x');
    await fs.copyFile(src, onPrimary('IMG.dng'));
    await fs.flushPendingMirrorOps();
    expect(await fileExists(onMirror('IMG.dng'))).toBe(true);

    await fs.unlink(onPrimary('IMG.dng'));
    await fs.flushPendingMirrorOps();
    expect(await fileExists(onPrimary('IMG.dng'))).toBe(false);
    expect(await fileExists(onMirror('IMG.dng'))).toBe(false);
  });

  test('a same-library rename moves the mirror copy (replicate dst + drop src)', async () => {
    const src = path.join(dir, 's.dng');
    await realFs.writeFile(src, 'move-me');
    await realFs.mkdir(onPrimary('old'), { recursive: true });
    await realFs.mkdir(onPrimary('new'), { recursive: true });
    await fs.copyFile(src, onPrimary('old/IMG.dng'));
    await fs.flushPendingMirrorOps();
    expect(await fileExists(onMirror('old/IMG.dng'))).toBe(true);

    await fs.rename(onPrimary('old/IMG.dng'), onPrimary('new/IMG.dng'));
    await fs.flushPendingMirrorOps();
    expect(await fileExists(onMirror('old/IMG.dng'))).toBe(false);
    expect(await realFs.readFile(onMirror('new/IMG.dng'), 'utf8')).toBe('move-me');
  });

  test('link replicates bytes to the mirror', async () => {
    const target = onPrimary('IMG.dng');
    await realFs.writeFile(target, 'linked');
    await fs.link(target, onPrimary('IMG-2.dng'));
    await fs.flushPendingMirrorOps();
    expect(await realFs.readFile(onMirror('IMG-2.dng'), 'utf8')).toBe('linked');
  });

  test('mkdir is created on the mirror as well', async () => {
    await fs.mkdir(onPrimary('a/b/c'), { recursive: true });
    await fs.flushPendingMirrorOps();
    expect((await realFs.stat(onMirror('a/b/c'))).isDirectory()).toBe(true);
  });

  test('paths outside the primary root are pure passthrough (no mirror writes)', async () => {
    const outside = path.join(dir, 'outside.dng');
    await realFs.writeFile(outside, 'nope');
    await fs.copyFile(outside, path.join(dir, 'outside-copy.dng'));
    await fs.flushPendingMirrorOps();
    // Nothing should have appeared under the mirror root.
    expect(await realFs.readdir(mirror)).toHaveLength(0);
  });

  test('a mirror failure does not fail or roll back the primary op', async () => {
    // Point the mirror at a *file* so mkdir/copy under it fails with ENOTDIR.
    const brokenMirror = path.join(dir, 'broken-mirror');
    await realFs.writeFile(brokenMirror, 'i am a file, not a dir');
    setMirrorRoots({ [primary]: [brokenMirror] });

    const src = path.join(dir, 's.dng');
    await realFs.writeFile(src, 'primary-must-survive');
    await realFs.mkdir(onPrimary('sub'), { recursive: true });
    // Must NOT throw even though replication can't succeed.
    await fs.copyFile(src, onPrimary('sub/IMG.dng'));
    await fs.flushPendingMirrorOps();
    expect(await realFs.readFile(onPrimary('sub/IMG.dng'), 'utf8')).toBe('primary-must-survive');
  });

  test('no-op when mirroring is inactive', async () => {
    clearMirrorRoots();
    expect(isMirroringActive()).toBe(false);
    const src = path.join(dir, 's.dng');
    await realFs.writeFile(src, 'x');
    await fs.copyFile(src, onPrimary('IMG.dng'));
    await fs.flushPendingMirrorOps();
    expect(await fileExists(onMirror('IMG.dng'))).toBe(false);
  });

  test('directory rename (folder move) moves the whole mirror subtree', async () => {
    // Seed a populated folder on the primary, mirrored.
    await realFs.mkdir(onPrimary('trip/day1'), { recursive: true });
    await realFs.writeFile(path.join(primary, 'trip/day1/a.dng'), 'A');
    await fs.copyFile(path.join(primary, 'trip/day1/a.dng'), onPrimary('trip/day1/a.dng'));
    await fs.flushPendingMirrorOps();
    expect(await fileExists(onMirror('trip/day1/a.dng'))).toBe(true);

    // Move the folder; the mirror subtree should follow.
    await fs.rename(onPrimary('trip'), onPrimary('vacation'));
    await fs.flushPendingMirrorOps();
    expect(await fileExists(onMirror('trip'))).toBe(false);
    expect(await realFs.readFile(onMirror('vacation/day1/a.dng'), 'utf8')).toBe('A');
  });

  test('directory rename rebuilds from primary when the mirror lacks the subtree', async () => {
    // Build the folder on the primary WITHOUT mirroring it (raw fs writes).
    await realFs.mkdir(onPrimary('raw/inner'), { recursive: true });
    await realFs.writeFile(path.join(primary, 'raw/inner/b.dng'), 'B');
    expect(await fileExists(onMirror('raw'))).toBe(false);

    // Renaming it should fall back to a recursive copy from the primary.
    await fs.rename(onPrimary('raw'), onPrimary('cooked'));
    await fs.flushPendingMirrorOps();
    expect(await realFs.readFile(onMirror('cooked/inner/b.dng'), 'utf8')).toBe('B');
  });

  test('directory rename out of the mirrored set removes the orphaned mirror subtree', async () => {
    await realFs.mkdir(onPrimary('gone/inner'), { recursive: true });
    await realFs.writeFile(path.join(primary, 'gone/inner/x.dng'), 'X');
    await fs.copyFile(path.join(primary, 'gone/inner/x.dng'), onPrimary('gone/inner/x.dng'));
    await fs.flushPendingMirrorOps();
    expect(await fileExists(onMirror('gone/inner/x.dng'))).toBe(true);

    // Move the folder OUT of the primary root (to a non-mirrored location):
    // dst has no mirror target, so the old mirror subtree must be cleaned up
    // rather than left to diverge.
    await fs.rename(onPrimary('gone'), path.join(dir, 'outside-dir'));
    await fs.flushPendingMirrorOps();
    expect(await fileExists(onMirror('gone'))).toBe(false);
  });

  test('utimes propagates the mtime to an existing mirror copy', async () => {
    const src = path.join(dir, 's.dng');
    await realFs.writeFile(src, 'x');
    await fs.copyFile(src, onPrimary('IMG.dng'));
    await fs.flushPendingMirrorOps();

    const epoch = new Date('2020-02-02T02:02:02Z');
    await fs.utimes(onPrimary('IMG.dng'), epoch, epoch);
    await fs.flushPendingMirrorOps();

    const mirrorStat = await realFs.stat(onMirror('IMG.dng'));
    expect(Math.abs(mirrorStat.mtimeMs - epoch.getTime())).toBeLessThan(1000);
  });

  test('replication preserves the source mtime on the mirror', async () => {
    const src = path.join(dir, 'src.dng');
    await realFs.writeFile(src, 'bytes');
    // Stamp the primary with a distinct, older mtime (as the upload route does
    // via utimes) so we can prove the mirror inherits it rather than "now".
    const epoch = new Date('2021-01-02T03:04:05Z');
    await realFs.copyFile(src, onPrimary('IMG.dng'));
    await realFs.utimes(onPrimary('IMG.dng'), epoch, epoch);
    // Re-copy through the mirrored layer so replication runs against the
    // stamped primary.
    await fs.copyFile(onPrimary('IMG.dng'), onPrimary('IMG2.dng'));
    await realFs.utimes(onPrimary('IMG2.dng'), epoch, epoch);
    await fs.copyFile(onPrimary('IMG2.dng'), onPrimary('IMG3.dng'));
    await fs.flushPendingMirrorOps();

    const mirrorStat = await realFs.stat(onMirror('IMG3.dng'));
    // IMG3 was copied from IMG2 (stamped epoch), so its primary mtime is epoch;
    // the mirror must match within filesystem mtime granularity (1s).
    const primaryStat = await realFs.stat(onPrimary('IMG3.dng'));
    expect(Math.abs(mirrorStat.mtimeMs - primaryStat.mtimeMs)).toBeLessThan(1000);
  });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await realFs.stat(p);
    return true;
  } catch {
    return false;
  }
}
