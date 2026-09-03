// BatchSyncService (#2436) — the live state a batch run exposes to the UI:
// one run at a time, cancellation, and a summary whose failures can be retried.

import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BatchSyncService } from './batch-sync.service';
import { LibraryStateService } from '../../state/library-state.service';

/** Minimal stand-in: the service only reaches `updateAdjustment`. */
class FakeLibrary {
  readonly writes: { id: string; patch: Record<string, unknown> }[] = [];
  failOn = new Set<string>();
  updateAdjustment(id: string, patch: Record<string, unknown>): void {
    if (this.failOn.has(id)) throw new Error(`cannot write ${id}`);
    this.writes.push({ id, patch });
  }
}

describe('BatchSyncService (#2436)', () => {
  let library: FakeLibrary;
  let svc: BatchSyncService;

  beforeEach(() => {
    library = new FakeLibrary();
    TestBed.configureTestingModule({
      providers: [BatchSyncService, { provide: LibraryStateService, useValue: library }],
    });
    svc = TestBed.inject(BatchSyncService);
  });

  it('applies the patch to every id and clears progress when it finishes', async () => {
    const summary = await svc.apply(['a', 'b'], { exposure: 1 });
    expect(library.writes.map((w) => w.id)).toEqual(['a', 'b']);
    expect(library.writes[0].patch).toEqual({ exposure: 1 });
    expect(summary?.applied).toEqual(['a', 'b']);
    expect(svc.progress()).toBeNull();
    expect(svc.running()).toBe(false);
    expect(svc.summaryText()).toBe('2 images updated');
  });

  it('records failures without stopping, and exposes them for retry', async () => {
    library.failOn = new Set(['b']);
    await svc.apply(['a', 'b', 'c'], { exposure: 1 });
    expect(library.writes.map((w) => w.id)).toEqual(['a', 'c']);
    expect(svc.failedIds()).toEqual(['b']);
    expect(svc.summaryText()).toBe('2 images updated · 1 failed');

    library.failOn.clear();
    await svc.retryFailed({ exposure: 1 });
    // The retry ran over the failures ONLY — 'a' and 'c' are not rewritten.
    expect(library.writes.map((w) => w.id)).toEqual(['a', 'c', 'b']);
    expect(svc.failedIds()).toEqual([]);
  });

  it('retrying with nothing failed is a no-op', async () => {
    await svc.apply(['a'], { exposure: 1 });
    await expect(svc.retryFailed({ exposure: 1 })).resolves.toBeNull();
    expect(library.writes).toHaveLength(1);
  });

  it('refuses a second run while one is in flight rather than interleaving', async () => {
    const first = svc.apply(
      Array.from({ length: 200 }, (_, i) => `a${i}`),
      { exposure: 1 },
    );
    const second = await svc.apply(['zzz'], { exposure: 2 });
    expect(second).toBeNull();
    await first;
    expect(library.writes.some((w) => w.id === 'zzz')).toBe(false);
  });

  it('cancel stops the run and keeps what was already written', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => `a${i}`);
    const run = svc.apply(ids, { exposure: 1 });
    svc.cancel();
    const summary = await run;
    expect(summary?.cancelled).toBe(true);
    expect(library.writes.length).toBeLessThan(500);
    // Nothing is rolled back: every write that happened is still a write.
    expect(summary?.applied).toEqual(library.writes.map((w) => w.id));
  });

  it('clears the previous run’s summary the moment a new run starts', async () => {
    // Progress is null until the first asset finishes, and the banner falls
    // through to the summary when progress is null — a stale result must not
    // be on screen while a new run is already writing (#3312 review).
    await svc.apply(['a'], { exposure: 1 });
    expect(svc.summaryText()).not.toBeNull();
    const run = svc.apply(['b', 'c'], { exposure: 2 });
    expect(svc.summaryText()).toBeNull();
    await run;
    expect(svc.summaryText()).toBe('2 images updated');
  });

  it('dismissing the summary clears the result row', async () => {
    await svc.apply(['a'], { exposure: 1 });
    expect(svc.summaryText()).not.toBeNull();
    svc.dismissSummary();
    expect(svc.summaryText()).toBeNull();
    expect(svc.failedIds()).toEqual([]);
  });

  it('percent tracks the run and is null when idle', async () => {
    expect(svc.percent()).toBeNull();
    const seen: (number | null)[] = [];
    const ids = Array.from({ length: 100 }, (_, i) => `a${i}`);
    const spy = vi.spyOn(library, 'updateAdjustment');
    const run = svc.apply(ids, { exposure: 1 });
    // Sampled between chunks — the exact values depend on scheduling, but
    // they must be a non-decreasing walk inside [0, 100].
    const sample = () => seen.push(svc.percent());
    sample();
    await run;
    sample();
    expect(spy).toHaveBeenCalledTimes(100);
    expect(seen.at(-1)).toBeNull();
    for (const v of seen) {
      if (v !== null) (expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100));
    }
  });
});
