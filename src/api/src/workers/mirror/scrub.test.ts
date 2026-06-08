/**
 * mirror-scrub tests. Pure temp-dir filesystem tests (no Mongo) — the scrub is
 * driven by an injected primary→mirrors map, the same shape the route passes
 * from the live registry snapshot.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMirrorScrubOnce } from './scrub.ts';

let primary: string;
let mirror: string;

beforeEach(() => {
  primary = mkdtempSync(join(tmpdir(), 'scrub-primary-'));
  mirror = mkdtempSync(join(tmpdir(), 'scrub-mirror-'));
});

afterEach(() => {
  rmSync(primary, { recursive: true, force: true });
  rmSync(mirror, { recursive: true, force: true });
});

describe('mirror-scrub', () => {
  it('dry run reports orphans but deletes nothing', async () => {
    // Mirror still holds the pre-migration copy under an old-layout dir; the
    // primary only has the new-layout path. The matched file is NOT an orphan.
    mkdirSync(join(mirror, '2024', '12-25'), { recursive: true });
    writeFileSync(join(mirror, '2024', '12-25', 'IMG.dng'), 'x'); // orphan (no primary)
    mkdirSync(join(primary, '2024', 'California'), { recursive: true });
    writeFileSync(join(primary, '2024', 'California', 'IMG.dng'), 'x');
    mkdirSync(join(mirror, '2024', 'California'), { recursive: true });
    writeFileSync(join(mirror, '2024', 'California', 'IMG.dng'), 'x'); // matched

    const r = await runMirrorScrubOnce({ rootMap: { [primary]: [mirror] } });

    expect(r.orphans).toBe(1);
    expect(r.deleted).toBe(0);
    expect(r.filesChecked).toBe(2);
    expect(r.samples).toContain(join(mirror, '2024', '12-25', 'IMG.dng'));
    expect(existsSync(join(mirror, '2024', '12-25', 'IMG.dng'))).toBe(true);
  });

  it('apply deletes orphans, keeps matched files, prunes emptied dirs', async () => {
    mkdirSync(join(mirror, '2024', '12-25'), { recursive: true });
    writeFileSync(join(mirror, '2024', '12-25', 'IMG.dng'), 'x'); // orphan
    writeFileSync(join(mirror, '2024', '12-25', 'IMG.xmp'), '<xmp/>'); // orphan sidecar
    mkdirSync(join(primary, '2024', 'California'), { recursive: true });
    writeFileSync(join(primary, '2024', 'California', 'IMG.dng'), 'x');
    mkdirSync(join(mirror, '2024', 'California'), { recursive: true });
    writeFileSync(join(mirror, '2024', 'California', 'IMG.dng'), 'x'); // keep

    const r = await runMirrorScrubOnce({ apply: true, rootMap: { [primary]: [mirror] } });

    expect(r.orphans).toBe(2);
    expect(r.deleted).toBe(2);
    expect(existsSync(join(mirror, '2024', '12-25', 'IMG.dng'))).toBe(false);
    expect(existsSync(join(mirror, '2024', '12-25'))).toBe(false); // emptied → pruned
    expect(r.dirsPruned).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(mirror, '2024', 'California', 'IMG.dng'))).toBe(true); // kept
  });

  it('skips the whole mirror when the primary root is offline (never deletes)', async () => {
    const offlinePrimary = join(tmpdir(), `scrub-primary-gone-${process.pid}-${Date.now()}`);
    writeFileSync(join(mirror, 'IMG.dng'), 'x');

    const r = await runMirrorScrubOnce({ apply: true, rootMap: { [offlinePrimary]: [mirror] } });

    expect(r.skippedOfflinePrimary).toBe(1);
    expect(r.mirrorsScanned).toBe(0);
    expect(r.deleted).toBe(0);
    expect(existsSync(join(mirror, 'IMG.dng'))).toBe(true); // untouched
  });

  it('ignores temp files', async () => {
    writeFileSync(join(mirror, 'IMG.dng.mirror.tmp.123.0'), 'x'); // temp, no primary
    const r = await runMirrorScrubOnce({ apply: true, rootMap: { [primary]: [mirror] } });
    expect(r.orphans).toBe(0);
    expect(r.deleted).toBe(0);
    expect(existsSync(join(mirror, 'IMG.dng.mirror.tmp.123.0'))).toBe(true);
  });

  it('respects maxDelete and still counts the rest', async () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(mirror, `orphan-${i}.dng`), 'x');
    const r = await runMirrorScrubOnce({
      apply: true,
      maxDelete: 2,
      rootMap: { [primary]: [mirror] },
    });
    expect(r.orphans).toBe(5);
    expect(r.deleted).toBe(2);
  });

  it('no-ops cleanly with an empty root map', async () => {
    const r = await runMirrorScrubOnce({ apply: true, rootMap: {} });
    expect(r).toMatchObject({ orphans: 0, deleted: 0, mirrorsScanned: 0 });
  });
});
