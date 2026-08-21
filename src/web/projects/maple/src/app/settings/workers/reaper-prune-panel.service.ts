// ReaperPrunePanelService — owns the missing-reaper "prune window" control on
// the Workers page. Extracted from WorkersComponent so that file stays under
// the LOC budget, following the same pattern as DamagedPanelService,
// MigrationPanelService, and ImportsPanelService; the markup stays in the
// component template.
//
// Provided at the component level (not root) — the state is ephemeral UI for
// one page, so it lives and dies with the component instance.

import { Injectable, inject, signal } from '@angular/core';
import { WorkersApiService, errorMessage } from '@maple-common';

type SaveState = 'idle' | 'saving' | 'success' | 'error';

/** How long a success tick stays lit before the control returns to idle. */
const SUCCESS_TICK_MS = 1500;

@Injectable()
export class ReaperPrunePanelService {
  private readonly api = inject(WorkersApiService);

  readonly window = signal<string>('');
  readonly loaded = signal<boolean>(false);
  readonly saveState = signal<SaveState>('idle');
  readonly error = signal<string | null>(null);

  fetch(): void {
    this.api.getReaperPruneWindow().subscribe({
      next: ({ hours }) => {
        this.window.set(String(hours));
        this.loaded.set(true);
      },
      error: (err: unknown) => this.error.set(errorMessage(err)),
    });
  }

  set(value: string): void {
    this.window.set(value);
  }

  save(): void {
    const hours = Number(this.window().trim());
    if (!Number.isFinite(hours) || hours < 1) {
      this.error.set('Enter a whole number of hours (≥ 1).');
      return;
    }
    this.saveState.set('saving');
    this.error.set(null);
    this.api.setReaperPruneWindow(Math.round(hours)).subscribe({
      next: ({ hours: saved }) => {
        this.window.set(String(saved));
        this.saveState.set('success');
        setTimeout(() => {
          if (this.saveState() === 'success') this.saveState.set('idle');
        }, SUCCESS_TICK_MS);
      },
      error: (err: unknown) => {
        this.saveState.set('error');
        this.error.set(errorMessage(err));
      },
    });
  }
}
