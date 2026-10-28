/**
 * ffi-pool-config repo tests — pure resolver precedence + clamp, plus a
 * round-trip against a per-test SQLite database.
 */

import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_DECODE_MEMORY_BUDGET_PERCENT,
  DEFAULT_FFI_WORKERS,
  MAX_DECODE_MEMORY_BUDGET_PERCENT,
  MAX_FFI_WORKERS,
  MIN_FFI_WORKERS,
  clampFfiWorkers,
  loadPerformanceConfig,
  resolveFfiPoolConfig,
  savePerformanceConfig,
} from './ffi-pool-config.repo.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';

describe('clampFfiWorkers', () => {
  it('clamps below MIN up to MIN', () => {
    expect(clampFfiWorkers(0)).toBe(MIN_FFI_WORKERS);
    expect(clampFfiWorkers(-3)).toBe(MIN_FFI_WORKERS);
  });
  it('clamps above MAX down to MAX', () => {
    expect(clampFfiWorkers(99)).toBe(MAX_FFI_WORKERS);
  });
  it('floors fractional values', () => {
    expect(clampFfiWorkers(3.9)).toBe(3);
  });
  it('returns null for non-finite input', () => {
    expect(clampFfiWorkers(Number.NaN)).toBeNull();
    expect(clampFfiWorkers(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('resolveFfiPoolConfig — precedence', () => {
  it('defaults to 1 when no DB row and no env var', () => {
    const r = resolveFfiPoolConfig(null, {});
    expect(r.ffi_workers).toBe(DEFAULT_FFI_WORKERS);
    expect(r.ffi_workers).toBe(1);
    expect(r.source.ffi_workers).toBe('default');
  });

  it('uses env var when there is no DB row', () => {
    const r = resolveFfiPoolConfig(null, { MAPLE_FFI_WORKERS: '4' });
    expect(r.ffi_workers).toBe(4);
    expect(r.source.ffi_workers).toBe('env');
  });

  it('clamps the env var into range', () => {
    expect(resolveFfiPoolConfig(null, { MAPLE_FFI_WORKERS: '999' }).ffi_workers).toBe(
      MAX_FFI_WORKERS,
    );
    expect(resolveFfiPoolConfig(null, { MAPLE_FFI_WORKERS: '0' }).ffi_workers).toBe(
      MIN_FFI_WORKERS,
    );
  });

  it('ignores a non-numeric env var (falls back to default)', () => {
    const r = resolveFfiPoolConfig(null, { MAPLE_FFI_WORKERS: 'banana' });
    expect(r.ffi_workers).toBe(DEFAULT_FFI_WORKERS);
    expect(r.source.ffi_workers).toBe('default');
  });

  it('DB row wins over env var', () => {
    const r = resolveFfiPoolConfig({ ffi_workers: 8 }, { MAPLE_FFI_WORKERS: '2' });
    expect(r.ffi_workers).toBe(8);
    expect(r.source.ffi_workers).toBe('db');
  });

  it('clamps the DB value into range', () => {
    expect(resolveFfiPoolConfig({ ffi_workers: 50 }, {}).ffi_workers).toBe(MAX_FFI_WORKERS);
    expect(resolveFfiPoolConfig({ ffi_workers: -1 }, {}).ffi_workers).toBe(MIN_FFI_WORKERS);
  });

  it('falls back to env when the DB field is null/missing', () => {
    const r = resolveFfiPoolConfig({ ffi_workers: null }, { MAPLE_FFI_WORKERS: '3' });
    expect(r.ffi_workers).toBe(3);
    expect(r.source.ffi_workers).toBe('env');
  });
});

describe('performance config — SQLite round-trip', () => {
  it('returns null before any row is written', async () => {
    using _live = await createLiveTestDatabase();
    expect(await loadPerformanceConfig()).toBeNull();
  });

  it('round-trips a saved ffi_workers value (DB overrides env)', async () => {
    using _live = await createLiveTestDatabase();
    await savePerformanceConfig({ ffi_workers: 6 });
    const loaded = await loadPerformanceConfig();
    expect(loaded?.ffi_workers).toBe(6);
    const resolved = resolveFfiPoolConfig(loaded, { MAPLE_FFI_WORKERS: '2' });
    expect(resolved.ffi_workers).toBe(6);
    expect(resolved.source.ffi_workers).toBe('db');
  });

  it('partial patch preserves the document and overwrites the field', async () => {
    using _live = await createLiveTestDatabase();
    await savePerformanceConfig({ ffi_workers: 3 });
    await savePerformanceConfig({ ffi_workers: 5 });
    const loaded = await loadPerformanceConfig();
    expect(loaded?.ffi_workers).toBe(5);
    expect(typeof loaded?.updated_at).toBe('number');
  });
});

describe('decode memory budget percent (#5467)', () => {
  it('defaults when nothing is saved', () => {
    const r = resolveFfiPoolConfig(null, {});
    expect(r.decode_memory_budget_percent).toBe(DEFAULT_DECODE_MEMORY_BUDGET_PERCENT);
    expect(r.source.decode_memory_budget_percent).toBe('default');
  });

  it('keeps a saved 0, the no-cap escape hatch', () => {
    const r = resolveFfiPoolConfig({ decode_memory_budget_percent: 0 }, {});
    expect(r.decode_memory_budget_percent).toBe(0);
    expect(r.source.decode_memory_budget_percent).toBe('db');
  });

  it('clamps a hand-edited value into range', () => {
    expect(
      resolveFfiPoolConfig({ decode_memory_budget_percent: 400 }, {}).decode_memory_budget_percent,
    ).toBe(MAX_DECODE_MEMORY_BUDGET_PERCENT);
    expect(
      resolveFfiPoolConfig({ decode_memory_budget_percent: -5 }, {}).decode_memory_budget_percent,
    ).toBe(0);
  });

  it('saves the percent without touching ffi_workers', async () => {
    using _live = await createLiveTestDatabase();
    await savePerformanceConfig({ ffi_workers: 6 });
    await savePerformanceConfig({ decode_memory_budget_percent: 35 });
    const resolved = resolveFfiPoolConfig(await loadPerformanceConfig(), {});
    expect(resolved.ffi_workers).toBe(6);
    expect(resolved.decode_memory_budget_percent).toBe(35);
  });
});
