// DeadLetterDialogComponent — modal listing dead-lettered docs for a stage.
//
// Opened from WorkersComponent when the operator clicks the dead-count badge.
// Fetches GET /api/workers/:name/dead on init and renders one row per doc with
// its file path, attempt count, last error, and most recent processed_at.
// Read-only — the retry button on the main row handles bulk reset.

import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnInit,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import {
  WorkersApiService,
  type DeadDoc,
  type StageStatus,
} from '@maple-common';

@Component({
  standalone: true,
  selector: 'maple-dead-letter-dialog',
  imports: [DatePipe, DecimalPipe],
  templateUrl: './dead-letter-dialog.component.html',
  styleUrl: './dead-letter-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeadLetterDialogComponent implements OnInit {
  private readonly api = inject(WorkersApiService);

  readonly stage = input.required<StageStatus>();
  readonly cancelled = output<void>();

  readonly items = signal<DeadDoc[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);

  ngOnInit(): void {
    this.api.listDead(this.stage().name).subscribe({
      next: (res) => {
        this.items.set(res.items);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.loadError.set(err?.error?.error ?? err?.message ?? 'Failed to load dead-letter list.');
      },
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.cancelled.emit();
  }

  close(): void {
    this.cancelled.emit();
  }

  fileName(absPath: string | null): string {
    if (!absPath) return '(unknown path)';
    const idx = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'));
    return idx >= 0 ? absPath.slice(idx + 1) : absPath;
  }
}
