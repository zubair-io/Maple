import {
  ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal,
} from '@angular/core';
import { Subscription, interval, switchMap, startWith } from 'rxjs';
import {
  BunApiBackendService,
  type IndexerStage,
  type IndexerStatus,
  type IndexerDeadLetterItem,
} from '../../api/bun-api-backend.service';

const STAGES: IndexerStage[] = ['discover', 'hash', 'exif', 'thumb', 'ai', 'mongo'];

@Component({
  selector: 'app-indexer-admin',
  standalone: true,
  templateUrl: './indexer-admin.component.html',
  styleUrl: './indexer-admin.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IndexerAdminComponent implements OnInit, OnDestroy {
  private readonly api = inject(BunApiBackendService);

  readonly stages = STAGES;
  readonly status = signal<IndexerStatus | null>(null);
  readonly deadLetter = signal<IndexerDeadLetterItem[]>([]);
  readonly error = signal<string | null>(null);

  private sub?: Subscription;

  ngOnInit(): void {
    // Poll every 2 seconds while open. Live WS upgrade lands in a follow-up commit.
    this.sub = interval(2000)
      .pipe(
        startWith(0),
        switchMap(() => this.api.getIndexerStatus()),
      )
      .subscribe({
        next: (s) => { this.status.set(s); this.error.set(null); },
        error: (e) => this.error.set(e?.error?.error ?? e?.message ?? 'Status failed.'),
      });

    this.api.listDeadLetter(50).subscribe({
      next: (p) => this.deadLetter.set(p.items),
      error: () => this.deadLetter.set([]),
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  togglePause(): void {
    const cur = this.status();
    if (!cur) return;
    const obs = cur.paused ? this.api.resumeIndexer() : this.api.pauseIndexer();
    obs.subscribe({ next: (r) => this.status.set(r.status) });
  }

  setPool(stage: IndexerStage, value: number): void {
    this.api.setIndexerWorkers({ [stage]: value }).subscribe({
      next: (r) => this.status.set(r.status),
    });
  }

  channelPct(stage: IndexerStage): number {
    const ch = this.status()?.channels[stage];
    if (!ch || ch.capacity === 0) return 0;
    return Math.round((ch.depth / ch.capacity) * 100);
  }
}
