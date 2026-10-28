import { afterEach, describe, expect, it } from 'bun:test';
import { applyPerformanceConfig, stopFfiPoolConfigRefresh } from './ffi-pool-bootstrap.ts';
import { savePerformanceConfig } from './ffi-pool-config.repo.ts';
import { decodeMemoryBudget } from './decode-memory-budget.ts';
import { readContainerMemory } from './container-memory.ts';
import { _resetFfiPoolForTests, ffiPool } from './ffi-pool.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';

afterEach(() => {
  stopFfiPoolConfigRefresh();
  decodeMemoryBudget().configure(null);
  _resetFfiPoolForTests();
});

describe('applyPerformanceConfig (worker side, #5467)', () => {
  it('caps decodes at the default share of the container limit on a fresh install', async () => {
    using _live = await createLiveTestDatabase();
    await applyPerformanceConfig();
    expect(decodeMemoryBudget().snapshot().limitBytes).toBe(
      Math.floor(readContainerMemory().limitBytes / 2),
    );
  });

  it('applies a saved percent and pool size, and lifts the cap at 0', async () => {
    using _live = await createLiveTestDatabase();
    await savePerformanceConfig({ ffi_workers: 6, decode_memory_budget_percent: 25 });
    await applyPerformanceConfig();
    expect(ffiPool().poolSize()).toBe(6);
    expect(decodeMemoryBudget().snapshot().limitBytes).toBe(
      Math.floor((readContainerMemory().limitBytes * 25) / 100),
    );

    await savePerformanceConfig({ decode_memory_budget_percent: 0 });
    await applyPerformanceConfig();
    expect(decodeMemoryBudget().capped()).toBe(false);
  });
});
