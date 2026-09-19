/**
 * Derivative-audit pass tests. Each one drives `runDerivativeAuditOnce`, which
 * reaches the database with no handle of its own, so each opens a live test
 * database for the block and seeds through it.
 *
 * The fixture is the exact post-move drift the worker exists for: the original
 * is present at its new path, its `.maple/` derivatives were left behind at the
 * old one, and every stage still says it finished.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import type { Database } from 'bun:sqlite';
// Mirror-aware wrapper per the fs-import guardrail (temp-path ops; no-op mirror).
import { mkdtemp, mkdir, writeFile, rm } from '../../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { insertAsset, insertLocation, run } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { addLibrary, createLiveTestDatabase } from './test-support.ts';
import { runDerivativeAuditOnce } from './scan.ts';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'audit-scan-'));
  await mkdir(path.join(root, 'y2024'), { recursive: true });
  await writeFile(path.join(root, 'y2024', 'p.dng'), 'raw');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Stage versions that mean "this stage finished at its current target". */
const DONE_VERSIONS: ReadonlyArray<readonly [string, number]> = [
  ['thumb', 3],
  ['preview', 4],
  ['describe', 7],
  ['cf-thumb-sync', 1],
];

/** Library + asset + locations + stage bookkeeping for the drifted fixture. */
function seedMovedAsset(db: Database): string {
  const library = addLibrary(db, root);
  const assetId = insertAsset(db);
  insertLocation(db, { assetId, libraryId: library, path: 'y2024', filename: 'p.dng' });
  run(db, `UPDATE assets SET maple_id = ? WHERE id = ?`, 'deadbeef', assetId);
  run(db, `INSERT INTO asset_detail (asset_id, description) VALUES (?, ?)`, assetId, 'a photo');
  markStagesDone(db, assetId);
  return assetId;
}

/** Put every stage back at its target version, as a stage that re-ran and
 * skipped without producing output would leave it. */
function markStagesDone(db: Database, assetId: string): void {
  for (const [stage, version] of DONE_VERSIONS) {
    run(
      db,
      `INSERT INTO stage_state (asset_id, stage, version) VALUES (?, ?, ?)
       ON CONFLICT (asset_id, stage) DO UPDATE SET version = excluded.version`,
      assetId,
      stage,
      version,
    );
  }
}

function stageVersion(db: Database, assetId: string, stage: string): number {
  const row = db
    .query(`SELECT version FROM stage_state WHERE asset_id = ? AND stage = ?`)
    .get(assetId, stage) as { version: number } | null;
  return row?.version ?? -1;
}

/** This asset's cooldown marks, as the audit stores them. */
function auditMarks(
  db: Database,
  assetId: string,
): Record<string, { attempts: number } | undefined> {
  const row = db
    .query(`SELECT derivative_audit FROM asset_detail WHERE asset_id = ?`)
    .get(assetId) as { derivative_audit: string | null } | null;
  return row?.derivative_audit ? JSON.parse(row.derivative_audit) : {};
}

describe('runDerivativeAuditOnce', () => {
  it('re-arms thumb + preview for a moved asset whose derivatives are gone', async () => {
    using live = await createLiveTestDatabase();
    const assetId = seedMovedAsset(live.db);

    const summary = await runDerivativeAuditOnce({ deep_r2_enabled: false });

    expect(summary.scanned).toBe(1);
    expect(summary.byStage.thumb).toBe(1);
    expect(summary.byStage.preview).toBe(1);
    expect(stageVersion(live.db, assetId, 'thumb')).toBe(0);
    expect(stageVersion(live.db, assetId, 'preview')).toBe(0);
    // Description present → describe is resolved, not drifted, so it is untouched.
    expect(stageVersion(live.db, assetId, 'describe')).toBe(7);
    expect(auditMarks(live.db, assetId).thumb?.attempts).toBe(1);
  });

  it('stops re-arming after AUDIT_MAX_ATTEMPTS (cooldown)', async () => {
    using live = await createLiveTestDatabase();
    const assetId = seedMovedAsset(live.db);

    for (let i = 0; i < 4; i++) {
      // Nothing regenerates here, so the drift persists — the auditor must stop
      // after the ceiling rather than re-arming forever. Putting the versions
      // back mimics a stage that re-ran and skipped without producing output.
      markStagesDone(live.db, assetId);
      await runDerivativeAuditOnce({ deep_r2_enabled: false });
    }

    expect(auditMarks(live.db, assetId).thumb?.attempts).toBe(3); // capped, not 4
  });

  it('preserves the cooldown mark while a re-armed stage sits queued below target', async () => {
    using live = await createLiveTestDatabase();
    const assetId = seedMovedAsset(live.db);

    // Pass 1: derivatives missing, stages at target → re-arm to 0, mark = 1.
    await runDerivativeAuditOnce({ deep_r2_enabled: false });
    expect(stageVersion(live.db, assetId, 'thumb')).toBe(0);
    expect(auditMarks(live.db, assetId).thumb?.attempts).toBe(1);

    // Pass 2: nothing regenerated, so the stages are still at 0 — queued, below
    // target. The auditor must leave the mark ALONE: clearing it would reset the
    // loop guard, bumping it would spend an attempt on a stage that has not had
    // its chance yet.
    await runDerivativeAuditOnce({ deep_r2_enabled: false });
    expect(auditMarks(live.db, assetId).thumb?.attempts).toBe(1);
  });

  it('honors max_resets_per_pass', async () => {
    using live = await createLiveTestDatabase();
    seedMovedAsset(live.db);

    const summary = await runDerivativeAuditOnce({
      deep_r2_enabled: false,
      max_resets_per_pass: 1,
    });

    expect(summary.reArmed).toBe(1); // stopped after one stage reset
  });
});
