// IndexerComponent — `/settings/indexer` (auth + owner-gated).
//
// Page-style replacement for the previous modal admin panel. Surfaces:
//   - Process status card (supervisor view of the standalone child process)
//   - Start/Stop buttons in the header (lifecycle of the indexer process)
//   - Pause / Resume controls + paused/started flags (pipeline state)
//   - Per-stage table: pool size, in-flight count, errors, channel depth,
//     cumulative-processed counter
//   - Per-stage in-flight file paths (collapsible) so an operator can see
//     exactly which files are being touched right now
//   - Dead-letter list with stage, path, and error reason

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { Subscription } from 'rxjs';
import {
  BunApiBackendService,
  IndexerEventsService,
  type IndexerStage,
  type IndexerStatus,
  type IndexerDeadLetterItem,
  type IndexerProcessState,
} from '@maple-common';

const STAGES: IndexerStage[] = ['discover', 'hash', 'exif', 'thumb', 'ai', 'mongo'];

/** Refresh cadence for the supervisor `process` poll. The pipeline status
 * is pushed over the WS — this poll covers the seconds when the child is
 * stopped/crashed and the WS isn't streaming. */
const PROCESS_POLL_MS = 2_000;

/** Transitional process states — used to disable lifecycle buttons while
 * a spawn or shutdown is mid-flight so the user doesn't double-click and
 * get inconsistent state. */
const TRANSITIONAL: ReadonlySet<IndexerProcessState['status']> = new Set([
  'starting',
  'restarting',
]);

@Component({
  standalone: true,
  selector: 'maple-indexer-settings',
  imports: [RouterLink, DecimalPipe],
  templateUrl: './indexer.component.html',
  styleUrl: './indexer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IndexerComponent implements OnInit, OnDestroy {
  private readonly api = inject(BunApiBackendService);
  private readonly events = inject(IndexerEventsService);

  readonly stages = STAGES;
  readonly status = signal<IndexerStatus | null>(null);
  readonly processState = signal<IndexerProcessState | null>(null);
  readonly deadLetter = signal<IndexerDeadLetterItem[]>([]);
  readonly error = signal<string | null>(null);

  /** Which stages have their in-flight paths drawer expanded. */
  readonly expandedInFlight = signal<Set<IndexerStage>>(new Set());

  /** Convenience: is the child reported as running by the supervisor? */
  readonly isRunning = computed(() => this.processState()?.status === 'running');
  readonly isStopped = computed(() => {
    const s = this.processState()?.status;
    return s === 'stopped' || s === 'crashed';
  });
  readonly isTransitional = computed(() => {
    const s = this.processState()?.status;
    return s !== undefined && TRANSITIONAL.has(s);
  });

  /** Total in-flight count (across all stages), used by the header summary. */
  readonly totalInFlight = computed(() => {
    const s = this.status();
    if (!s) return 0;
    return STAGES.reduce((acc, st) => acc + s.stages[st].inFlight, 0);
  });

  /** Total queued count (channel depths across stages). */
  readonly totalQueued = computed(() => {
    const s = this.status();
    if (!s) return 0;
    return STAGES.reduce((acc, st) => acc + s.channels[st].depth, 0);
  });

  /** Total processed count (cumulative since process start). */
  readonly totalProcessed = computed(() => {
    const s = this.status();
    if (!s?.processed) return 0;
    return STAGES.reduce((acc, st) => acc + (s.processed?.[st] ?? 0), 0);
  });

  /** Total errors observed since process start. */
  readonly totalErrors = computed(() => {
    const s = this.status();
    if (!s) return 0;
    return STAGES.reduce((acc, st) => acc + s.stages[st].errors, 0);
  });

  /** UI label for the process state card. */
  readonly processLabel = computed(() => {
    const ps = this.processState();
    if (!ps) return '—';
    switch (ps.status) {
      case 'running': return 'Running';
      case 'stopped': return 'Stopped';
      case 'starting': return 'Starting…';
      case 'restarting': return 'Restarting…';
      case 'crashed': return 'Crashed';
    }
  });

  /** Color class for the process state card. */
  readonly processStateClass = computed<'ok' | 'warn' | 'err' | 'muted'>(() => {
    const s = this.processState()?.status;
    if (s === 'running') return 'ok';
    if (s === 'crashed') return 'err';
    if (s === 'starting' || s === 'restarting') return 'warn';
    return 'muted';
  });

  private sub?: Subscription;
  private processTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    // Initial pipeline status (only meaningful while the child is up; the
    // proxy returns 503 when it's down — fall back to nothing).
    this.api.getIndexerStatus().subscribe({
      next: (s) => {
        this.status.set(s);
        this.error.set(null);
      },
      error: (e) => {
        // Quiet failure when the child is stopped — the empty state UI
        // covers it.
        if (e?.status !== 503) {
          this.error.set(e?.error?.error ?? e?.message ?? 'Status failed.');
        }
      },
    });

    // Live pipeline status over WS while the child is running.
    this.events.connect();
    this.sub = this.events.status$.subscribe((s) => {
      if (s) this.status.set(s);
    });

    // Supervisor poll. Independent of the WS — keeps working when the
    // child is stopped or crashed.
    this.refreshProcessState();
    this.processTimer = setInterval(() => this.refreshProcessState(), PROCESS_POLL_MS);

    this.api.listDeadLetter(200).subscribe({
      next: (p) => this.deadLetter.set(p.items),
      error: () => this.deadLetter.set([]),
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.events.disconnect();
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
  }

  private refreshProcessState(): void {
    this.api.getIndexerProcess().subscribe({
      next: (ps) => this.processState.set(ps),
      error: () => {
        // The /process endpoint hits the supervisor directly; only fails
        // if the parent server itself is down.
      },
    });
  }

  startIndexer(): void {
    this.error.set(null);
    this.api.startIndexer().subscribe({
      next: (r) => {
        this.processState.set(r.state);
        if (!r.ok && r.error) this.error.set(r.error);
      },
      error: (e) => this.error.set(e?.error?.error ?? e?.message ?? 'Start failed.'),
    });
  }

  stopIndexer(): void {
    if (!confirm('Stop the indexer process? In-flight jobs will be persisted but no new work will be picked up.')) {
      return;
    }
    this.error.set(null);
    this.api.stopIndexer().subscribe({
      next: (r) => this.processState.set(r.state),
      error: (e) => this.error.set(e?.error?.error ?? e?.message ?? 'Stop failed.'),
    });
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

  refreshDeadLetter(): void {
    this.api.listDeadLetter(200).subscribe({
      next: (p) => this.deadLetter.set(p.items),
      error: () => this.deadLetter.set([]),
    });
  }

  /** Kick off an EXIF backfill. Server returns immediately; the live status
   * stream picks up the progress on the next tick so the UI updates without
   * a manual refresh. */
  runBackfill(): void {
    this.api.runExifBackfill().subscribe({
      next: (r) => this.status.set(r.status),
      error: (e) => this.error.set(e?.error?.error ?? e?.message ?? 'Backfill failed.'),
    });
  }

  backfillPct(): number {
    const b = this.status()?.exifBackfill;
    if (!b) return 0;
    if (b.pending <= 0) return b.scanned > 0 ? 100 : 0;
    return Math.round((b.scanned / (b.scanned + b.pending)) * 100);
  }

  channelPct(stage: IndexerStage): number {
    const ch = this.status()?.channels[stage];
    if (!ch || ch.capacity === 0) return 0;
    return Math.round((ch.depth / ch.capacity) * 100);
  }

  inFlightPaths(stage: IndexerStage): string[] {
    return this.status()?.inFlightPaths?.[stage] ?? [];
  }

  toggleInFlight(stage: IndexerStage): void {
    this.expandedInFlight.update((s) => {
      const next = new Set(s);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  }

  isInFlightExpanded(stage: IndexerStage): boolean {
    return this.expandedInFlight().has(stage);
  }

  basename(p: string): string {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
  }
}
