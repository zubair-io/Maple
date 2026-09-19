/**
 * DeDuplicate config repo. The clamp is pure; the load/save round-trip runs
 * against a per-test SQLite database.
 */

import { describe, it, expect } from 'bun:test';
import {
  clampBatchSize,
  DEFAULT_BATCH_SIZE,
  loadDeDuplicateConfig,
  saveDeDuplicateConfig,
} from './dedupe-config.repo.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';

describe('clampBatchSize', () => {
  it('keeps an in-range value, rounding floats', () => {
    expect(clampBatchSize(200)).toBe(200);
    expect(clampBatchSize(12.7)).toBe(13);
  });
  it('clamps to [1, 5000]', () => {
    expect(clampBatchSize(0)).toBe(1);
    expect(clampBatchSize(-50)).toBe(1);
    expect(clampBatchSize(999999)).toBe(5000);
  });
  it('falls back to the default for non-finite input', () => {
    expect(clampBatchSize(NaN)).toBe(DEFAULT_BATCH_SIZE);
    expect(clampBatchSize(Infinity)).toBe(DEFAULT_BATCH_SIZE); // non-finite → default, not clamped
  });
});

describe('load/save round-trip', () => {
  it('defaults when no doc exists, then persists a partial patch', async () => {
    using _live = await createLiveTestDatabase();

    const def = await loadDeDuplicateConfig();
    expect(def).toEqual({ batch_size: DEFAULT_BATCH_SIZE, dry_run: false });

    const saved = await saveDeDuplicateConfig({ dry_run: true });
    expect(saved.dry_run).toBe(true);
    expect(saved.batch_size).toBe(DEFAULT_BATCH_SIZE); // untouched field keeps default

    const reread = await loadDeDuplicateConfig();
    expect(reread.dry_run).toBe(true);

    const clamped = await saveDeDuplicateConfig({ batch_size: 99999 });
    expect(clamped.batch_size).toBe(5000); // clamped on write
    expect(clamped.dry_run).toBe(true); // prior field preserved
  });
});
