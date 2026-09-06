import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchSyncService } from './batch-sync.service';
import { PERSISTED_BATCH_SYNC, type PersistedBatchSync } from './persisted-batch-sync';
import type { BatchProgress, BatchSummary } from './batch-sync';
import { defaultAdjustmentModel } from '../../models/adjustment-model';

// This tests the UI facade's dispatch, not sidecar I/O. The latter is exercised
// with real files in batch-persistence.spec and actual Worker/IndexedDB E2E.
describe('batch facade', () => {
  let port: PersistedBatchSync;
  let service: BatchSyncService;
  const progress = signal<BatchProgress<string> | null>(null);
  const summary = signal<BatchSummary<string> | null>(null);
  beforeEach(() => {
    progress.set(null);
    summary.set(null);
    port = {
      progress,
      lastSummary: summary,
      error: signal(null),
      remaining: signal([]),
      needsReconnect: signal(false),
      apply: vi.fn(async () => null),
      retryFailed: vi.fn(async () => null),
      resume: vi.fn(async () => null),
      reconnect: vi.fn(async () => null),
      cancel: vi.fn(),
      dismissSummary: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: PERSISTED_BATCH_SYNC, useValue: port }],
    });
    service = TestBed.inject(BatchSyncService);
  });
  it('passes the frozen transfer context to the deployment runner', async () => {
    const transfer = {
      source: defaultAdjustmentModel(),
      groups: ['tone'] as const,
      relativeWhiteBalance: false,
    };
    await service.apply(['a'], { exposure: 1 }, transfer);
    expect(port.apply).toHaveBeenCalledExactlyOnceWith(['a'], { exposure: 1 }, transfer);
  });
  it('derives progress and exact outcomes from the persisted runner', () => {
    progress.set({
      total: 4,
      processed: 2,
      applied: 1,
      failed: 1,
      current: 'b',
      outcome: 'failed',
    });
    expect(service.running()).toBe(true);
    expect(service.percent()).toBe(50);
    progress.set(null);
    summary.set({ applied: ['a'], failed: [{ id: 'b', reason: 'disk full' }], cancelled: true });
    expect(service.running()).toBe(false);
    expect(service.failedIds()).toEqual(['b']);
    expect(service.summaryText()).toContain('1 failed');
  });
  it('uses stored retry data and forwards recovery, cancellation and dismissal', async () => {
    await service.retryFailed({ exposure: 99 });
    service.resume();
    service.reconnect();
    service.cancel();
    service.dismissSummary();
    expect(port.retryFailed).toHaveBeenCalledExactlyOnceWith();
    expect(port.resume).toHaveBeenCalledOnce();
    expect(port.reconnect).toHaveBeenCalledOnce();
    expect(port.cancel).toHaveBeenCalledOnce();
    expect(port.dismissSummary).toHaveBeenCalledOnce();
  });
});
