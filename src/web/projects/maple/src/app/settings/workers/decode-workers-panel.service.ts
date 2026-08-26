// DecodeWorkersPanelService — owns the "Parallel RAW decode workers"
// (ffi_workers) control inside the "preview" stage's expanded panel on the
// Workers page. Extracted from WorkersComponent so that file stays under the
// LOC budget (#3020 follow-up — the mui-* migration pushed it to 572 lines),
// following the same pattern as DamagedPanelService, MigrationPanelService,
// ImportsPanelService, and ReaperPrunePanelService; the markup stays in the
// component template.
//
// Provided at the component level (not root) — the state is ephemeral UI for
// one page, so it lives and dies with the component instance.

import { Injectable, inject, signal } from '@angular/core';
import { WorkersApiService, errorMessage, type PerformanceConfig } from '@maple-common';
import { parseClampedInt } from './workers.vm';

type SaveState = 'idle' | 'saving' | 'success' | 'error';

/** How long a success tick stays lit before the control returns to idle. */
const SUCCESS_TICK_MS = 1500;

@Injectable()
export class DecodeWorkersPanelService {
  private readonly api = inject(WorkersApiService);

  readonly config = signal<PerformanceConfig | null>(null);
  readonly draft = signal<string>('');
  readonly saveState = signal<SaveState>('idle');
  readonly saveError = signal<string | null>(null);

  fetch(): void {
    this.api.getPerformanceConfig().subscribe({
      next: (cfg) => {
        this.config.set(cfg);
        if (this.draft() === '') this.draft.set(String(cfg.ffi_workers));
      },
      error: () => {},
    });
  }

  setDraft(value: string): void {
    this.draft.set(value);
  }

  save(): void {
    const cfg = this.config();
    if (!cfg) return;
    const n = parseClampedInt(this.draft(), cfg.min, cfg.max, cfg.ffi_workers);
    this.saveState.set('saving');
    this.saveError.set(null);
    this.api.patchPerformanceConfig(n).subscribe({
      next: (res) => {
        this.config.update((cur) =>
          cur ? { ...cur, ffi_workers: res.ffi_workers, source: res.source, pool: res.pool } : cur,
        );
        this.draft.set(String(res.ffi_workers));
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
