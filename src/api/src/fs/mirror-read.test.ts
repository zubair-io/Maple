/**
 * mirror-read.ts integration tests — real temp dirs, no Mongo.
 *
 * The safety-critical half of the read replica. What is asserted here:
 *   - originals round-robin across primary + mirror, but ONLY when the mirror
 *     copy is provably the same file;
 *   - a mirror that is disabled (absent from the registry) or benched
 *     (unhealthy) is never read from, on either path;
 *   - failover happens only when the primary ROOT is unreachable — a file
 *     missing from a healthy primary stays a miss, so a deleted photo can never
 *     be resurrected from the backup;
 *   - mutable XMP reads stay on the primary.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import realFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setMirrorRoots, clearMirrorRoots } from './mirror-registry.ts';
import {
  resolveOriginalReadSource,
  readFileWithFailover,
  markMirrorUnhealthy,
  resetMirrorHealth,
  resetReadBalancer,
  benchedMirrors,
} from './mirror-read.ts';

let dir: string;
let primary: string;
let mirror: string;

/** Write the same bytes to both replicas and align the mirror's mtime, the way
 * every replication path in the codebase leaves them. */
async function writeReplicated(rel: string, bytes: string): Promise<void> {
  const p = path.join(primary, rel);
  const m = path.join(mirror, rel);
  await realFs.mkdir(path.dirname(p), { recursive: true });
  await realFs.mkdir(path.dirname(m), { recursive: true });
  await realFs.writeFile(p, bytes);
  await realFs.writeFile(m, bytes);
  const st = await realFs.stat(p);
  await realFs.utimes(m, st.atime, st.mtime);
}

/** Simulate an unmounted primary volume: the root itself disappears. */
async function unmountPrimary(): Promise<void> {
  await realFs.rename(primary, path.join(dir, 'primary-detached'));
}

beforeEach(async () => {
  dir = await realFs.realpath(await realFs.mkdtemp(path.join(os.tmpdir(), 'maple-mirror-read-')));
  primary = path.join(dir, 'primary');
  mirror = path.join(dir, 'mirror');
  await realFs.mkdir(primary, { recursive: true });
  await realFs.mkdir(mirror, { recursive: true });
  setMirrorRoots({ [primary]: [mirror] });
  resetMirrorHealth();
  resetReadBalancer();
});

afterEach(async () => {
  clearMirrorRoots();
  resetMirrorHealth();
  await realFs.rm(dir, { recursive: true, force: true });
});

describe('resolveOriginalReadSource — load balancing', () => {
  test('round-robins between the primary and a faithful mirror copy', async () => {
    await writeReplicated('IMG.dng', 'raw-bytes');
    const src = path.join(primary, 'IMG.dng');

    const origins: string[] = [];
    for (let i = 0; i < 4; i++) {
      const picked = await resolveOriginalReadSource(src);
      origins.push(picked!.origin);
    }
    // Both replicas get used; neither is starved.
    expect(origins.filter((o) => o === 'mirror').length).toBe(2);
    expect(origins.filter((o) => o === 'primary').length).toBe(2);
  });

  test('a mirror-served read reports the mirror path but the primary stat', async () => {
    await writeReplicated('IMG.dng', 'raw-bytes');
    const src = path.join(primary, 'IMG.dng');
    const primaryStat = await realFs.stat(src);

    // The balancer's first pick with a fresh cursor is the mirror.
    const picked = await resolveOriginalReadSource(src);
    expect(picked!.origin).toBe('mirror');
    expect(picked!.path).toBe(path.join(mirror, 'IMG.dng'));
    // ETag + Content-Length must not depend on which replica served.
    expect(picked!.stat.size).toBe(primaryStat.size);
    expect(Math.floor(picked!.stat.mtimeMs)).toBe(Math.floor(primaryStat.mtimeMs));
  });

  test('falls back to the primary when the mirror copy is not byte-identical', async () => {
    await writeReplicated('IMG.dng', 'raw-bytes');
    // Mirror drifted (a partial/failed replication) — size no longer matches.
    await realFs.writeFile(path.join(mirror, 'IMG.dng'), 'raw-bytes-but-longer');
    const picked = await resolveOriginalReadSource(path.join(primary, 'IMG.dng'));
    expect(picked!.origin).toBe('primary');
    expect(picked!.path).toBe(path.join(primary, 'IMG.dng'));
  });

  test('falls back to the primary when the mirror has no copy at all', async () => {
    await realFs.writeFile(path.join(primary, 'IMG.dng'), 'raw-bytes');
    const picked = await resolveOriginalReadSource(path.join(primary, 'IMG.dng'));
    expect(picked!.origin).toBe('primary');
  });

  test('never reads from a disabled mirror (absent from the registry)', async () => {
    await writeReplicated('IMG.dng', 'raw-bytes');
    // `mirror-config.ts` drops disabled mirrors when building the registry, so
    // "disabled" is exactly "not resolvable" here.
    setMirrorRoots({});
    for (let i = 0; i < 4; i++) {
      const picked = await resolveOriginalReadSource(path.join(primary, 'IMG.dng'));
      expect(picked!.origin).toBe('primary');
    }
  });

  test('never reads from a benched (unhealthy) mirror', async () => {
    await writeReplicated('IMG.dng', 'raw-bytes');
    markMirrorUnhealthy(mirror);
    expect(benchedMirrors().map((b) => b.root)).toContain(mirror);
    for (let i = 0; i < 4; i++) {
      const picked = await resolveOriginalReadSource(path.join(primary, 'IMG.dng'));
      expect(picked!.origin).toBe('primary');
    }
  });
});

describe('resolveOriginalReadSource — failover', () => {
  test('serves from the mirror when the primary volume is unreachable', async () => {
    await writeReplicated('IMG.dng', 'raw-bytes');
    await unmountPrimary();

    const picked = await resolveOriginalReadSource(path.join(primary, 'IMG.dng'));
    expect(picked).not.toBeNull();
    expect(picked!.origin).toBe('mirror');
    expect(picked!.path).toBe(path.join(mirror, 'IMG.dng'));
    expect(await realFs.readFile(picked!.path, 'utf-8')).toBe('raw-bytes');
  });

  test('does NOT fail over for a file missing from a healthy primary', async () => {
    // The mirror still holds a copy — e.g. a delete whose mirror unlink is
    // still queued. Serving it would resurrect a deleted photo.
    await realFs.writeFile(path.join(mirror, 'IMG.dng'), 'stale-copy');
    const picked = await resolveOriginalReadSource(path.join(primary, 'IMG.dng'));
    expect(picked).toBeNull();
  });

  test('does not fail over to a benched mirror', async () => {
    await writeReplicated('IMG.dng', 'raw-bytes');
    markMirrorUnhealthy(mirror);
    await unmountPrimary();
    expect(await resolveOriginalReadSource(path.join(primary, 'IMG.dng'))).toBeNull();
  });

  test('returns null when neither replica has the file', async () => {
    await unmountPrimary();
    expect(await resolveOriginalReadSource(path.join(primary, 'GONE.dng'))).toBeNull();
  });

  test('is a plain stat when no mirror is configured', async () => {
    clearMirrorRoots();
    await realFs.writeFile(path.join(primary, 'IMG.dng'), 'raw-bytes');
    const picked = await resolveOriginalReadSource(path.join(primary, 'IMG.dng'));
    expect(picked!.origin).toBe('primary');
    expect(await resolveOriginalReadSource(path.join(primary, 'NOPE.dng'))).toBeNull();
  });

  test('a directory is not a readable source', async () => {
    await realFs.mkdir(path.join(primary, 'sub.dng'));
    expect(await resolveOriginalReadSource(path.join(primary, 'sub.dng'))).toBeNull();
  });
});

describe('readFileWithFailover — mutable sidecars', () => {
  test('reads the primary even when a mirror copy exists', async () => {
    await writeReplicated('IMG.xmp', '<primary/>');
    // Mirror lags by one queue drain — the primary must still win.
    await realFs.writeFile(path.join(mirror, 'IMG.xmp'), '<stale/>');
    expect(await readFileWithFailover(path.join(primary, 'IMG.xmp'))).toBe('<primary/>');
  });

  test('rethrows for a sidecar missing from a healthy primary', async () => {
    await realFs.writeFile(path.join(mirror, 'IMG.xmp'), '<stale/>');
    await expect(readFileWithFailover(path.join(primary, 'IMG.xmp'))).rejects.toThrow();
  });

  test('falls back to the mirror when the primary volume is unreachable', async () => {
    await writeReplicated('IMG.xmp', '<edits/>');
    await unmountPrimary();
    expect(await readFileWithFailover(path.join(primary, 'IMG.xmp'))).toBe('<edits/>');
  });

  test('does not fall back to a benched mirror', async () => {
    await writeReplicated('IMG.xmp', '<edits/>');
    markMirrorUnhealthy(mirror);
    await unmountPrimary();
    await expect(readFileWithFailover(path.join(primary, 'IMG.xmp'))).rejects.toThrow();
  });

  test('rethrows when no mirror is configured', async () => {
    clearMirrorRoots();
    await expect(readFileWithFailover(path.join(primary, 'IMG.xmp'))).rejects.toThrow();
  });
});
