// DecodeWorkersPanelService — owns the "Parallel RAW decode workers"
// (ffi_workers) and "Decode memory budget" (#5467) controls inside the
// "preview" stage's expanded panel on the Workers page. Extracted from
// WorkersComponent so that file stays under the LOC budget (#3020 follow-up — the mui-* migration pushed it to 572 lines),
// following the same pattern as DamagedPanelService, MigrationPanelService,
// ImportsPanelService, and ReaperPrunePanelService; the markup stays in the
// component template.
//
// Provided at the component level (not root) — the state is ephemeral UI for
// one page, so it lives and dies with the component instance.

import { Injectable, computed, inject, signal } from '@angular/core';
import {
  WorkersApiService,
  errorMessage,
  type PerformanceConfig,
  type PerformancePatch,
} from '@maple-common';
import { formatBytes, parseClampedInt } from './workers.vm';

type SaveState = 'idle' | 'saving' | 'success' | 'error';

/** How long a success tick stays lit before the control returns to idle. */
const SUCCESS_TICK_MS = 1500;

@Injectable()
export class DecodeWorkersPanelService {
  private readonly api = inject(WorkersApiService);

  readonly config = signal<PerformanceConfig | null>(null);
  readonly draft = signal<string>('');
  readonly budgetDraft = signal<string>('');

  /** "Reserved 6.4 GB of 22.0 GB · 1 running · 2 waiting", or null before the
   * worker's first sample (or from a server without the budget). */
  readonly budgetReadout = computed(() => {
    const live = this.config()?.decode_memory_budget?.live;
    if (!live) return null;
    const limit = live.limit_bytes === null ? 'no cap' : formatBytes(live.limit_bytes);
    return `Reserved ${formatBytes(live.reserved_bytes)} of ${limit} · ${live.running} running · ${live.waiting} waiting`;
  });
  readonly saveState = signal<SaveState>('idle');
  readonly saveError = signal<string | null>(null);

  fetch(): void {
    this.api.getPerformanceConfig().subscribe({
      next: (cfg) => {
        this.config.set(cfg);
        if (this.draft() === '') this.draft.set(String(cfg.ffi_workers));
        const budget = cfg.decode_memory_budget;
        if (budget && this.budgetDraft() === '') this.budgetDraft.set(String(budget.percent));
      },
      error: () => {},
    });
  }

  setDraft(value: string): void {
    this.draft.set(value);
  }

  setBudgetDraft(value: string): void {
    this.budgetDraft.set(value);
  }

  save(): void {
    const cfg = this.config();
    if (!cfg) return;
    const n = parseClampedInt(this.draft(), cfg.min, cfg.max, cfg.ffi_workers);
    const budget = cfg.decode_memory_budget;
    const patch: PerformancePatch = budget
      ? {
          ffi_workers: n,
          decode_memory_budget_percent: parseClampedInt(
            this.budgetDraft(),
            budget.min,
            budget.max,
            budget.percent,
          ),
        }
      : { ffi_workers: n };
    this.saveState.set('saving');
    this.saveError.set(null);
    this.api.patchPerformanceConfig(patch).subscribe({
      next: (res) => {
        this.config.update((cur) =>
          cur
            ? {
                ...cur,
                ffi_workers: res.ffi_workers,
                source: res.source,
                pool: res.pool,
                decode_memory_budget: res.decode_memory_budget ?? cur.decode_memory_budget,
              }
            : cur,
        );
        this.draft.set(String(res.ffi_workers));
        if (res.decode_memory_budget) {
          this.budgetDraft.set(String(res.decode_memory_budget.percent));
        }
        this.saveState.set('success');
        setTimeout(() => {
          if (this.saveState() === 'success') this.saveState.set('idle');
        }, SUCCESS_TICK_MS);
      },
      error: (err: unknown) => {
        this.saveState.set('error');
        this.saveError.set(errorMessage(err));
      },
    });
  }
}
