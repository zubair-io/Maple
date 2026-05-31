// ImportsPanelComponent — the "Imports" panel on the Workers page (ticket
// #742 follow-up). Shows the import jobs queue with live state, a status link
// per job (deep-links into the Imports wizard's progress view), and a
// "New import" button. The wizard itself stays at /settings/imports.
//
// Standalone + self-contained (its own light poll), so it can drop into the
// Workers template as `<maple-imports-panel/>` without touching the
// WorkersComponent's already-large state.

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { ImportsApiService, type ImportSummary } from '@maple-common';
import { SettingsIconComponent } from '../settings-icon.component';

const POLL_MS = 4000;

@Component({
  selector: 'maple-imports-panel',
  standalone: true,
  imports: [RouterLink, SettingsIconComponent],
  templateUrl: './imports-panel.component.html',
  styleUrl: './imports-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImportsPanelComponent implements OnInit, OnDestroy {
  private readonly api = inject(ImportsApiService);

  protected readonly jobs = signal<ImportSummary[]>([]);
  protected readonly error = signal<string | null>(null);

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  ngOnInit(): void {
    this.fetch();
    this.timer = setInterval(() => this.fetch(), POLL_MS);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Reload the job list. Skips while a prior request is in flight so the
   * interval can't stack overlapping responses that race. */
  private fetch(): void {
    if (this.inFlight) return;
    this.inFlight = true;
    this.api.list(undefined, 25).subscribe({
      next: ({ imports }) => {
        this.inFlight = false;
        this.jobs.set(imports);
        this.error.set(null);
      },
      error: (e: unknown) => {
        this.inFlight = false;
        this.error.set(e instanceof Error ? e.message : String(e));
      },
    });
  }

  protected basename(p: string): string {
    const trimmed = p.replace(/\/+$/, '');
    const i = trimmed.lastIndexOf('/');
    return i >= 0 ? trimmed.slice(i + 1) || '/' : trimmed;
  }

  protected percent(j: ImportSummary): number {
    if (j.progress.total === 0) return 0;
    return Math.round((j.progress.current / j.progress.total) * 100);
  }

  protected active(j: ImportSummary): boolean {
    return j.status === 'pending' || j.status === 'running';
  }
}
