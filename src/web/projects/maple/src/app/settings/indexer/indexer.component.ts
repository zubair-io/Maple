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
//   - Dead-letter triage card — defaults to a clustered group view (one row
//     per (stage, error class)) with a per-stage reset button. Toggling to
//     "List" reveals filter inputs (stage + error-prefix) and per-row resets.

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
import { Subscription, Subject, of, type Observable } from 'rxjs';
import { catchError, debounceTime, switchMap, tap } from 'rxjs/operators';
import {
  BunApiBackendService,
  IndexerEventsService,
  type IndexerStage,
  type IndexerStatus,
  type IndexerDeadLetterItem,
  type IndexerDeadLetterGroup,
  type IndexerDeadLetterPage,
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
  readonly deadLetterGroups = signal<IndexerDeadLetterGroup[]>([]);
  readonly error = signal<string | null>(null);

  // ── Triage state (group/list view + filters) ────────────────────────────
  /** Triage view mode. Defaults to "group" so the first thing an operator
   * sees is the failure-mode breakdown, not a flat row dump. */
  readonly triageView = signal<'group' | 'list'>('group');
  /** List-view filter: stage dropdown. `null` = no filter. */
  readonly filterStage = signal<IndexerStage | null>(null);
  /** List-view filter: error-prefix substring. Empty string = no filter. */
  readonly filterErrorPrefix = signal<string>('');
  /** True while the list/group fetch is in flight. */
  readonly triageLoading = signal<boolean>(false);

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
  /** Debounced filter trigger — emits whenever `filterStage` or
   * `filterErrorPrefix` changes; the resulting `switchMap` cancels in-flight
   * requests when the user keeps typing. */
  private readonly filterChange$ = new Subject<void>();
  private filterSub?: Subscription;

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

    // Initial load: keep the historical 200-row fetch (covers the list-view
    // default of "no filter") AND fire the groups call so the default group
    // view has data on first paint.
    this.loadList();
    this.loadGroups();

    // Debounced filter pipeline: 300 ms after the last input change, refetch
    // the list with whatever the current filter signals say. switchMap
    // cancels any in-flight request from a previous keystroke.
    this.filterSub = this.filterChange$
      .pipe(
        debounceTime(300),
        switchMap(() => this.fetchList$()),
      )
      .subscribe((p) => this.deadLetter.set(p.items));
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.filterSub?.unsubscribe();
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

  // ── Dead-letter triage ──────────────────────────────────────────────────

  /** Force-refetch both the list and the groups (used by the Refresh button
   * and after a successful reset). The groups call is the source of truth
   * for the group-view counts — recomputing client-side from the list would
   * undercount whenever the list is filtered/limited. */
  refreshDeadLetter(): void {
    this.loadList();
    this.loadGroups();
  }

  setTriageView(view: 'group' | 'list'): void {
    this.triageView.set(view);
  }

  /** Stage filter change handler (template-driven). */
  onFilterStageChange(value: string): void {
    this.filterStage.set(value === '' ? null : (value as IndexerStage));
    this.filterChange$.next();
  }

  /** Error-prefix filter change handler. */
  onFilterErrorPrefixChange(value: string): void {
    this.filterErrorPrefix.set(value);
    this.filterChange$.next();
  }

  /** Reset every dead-letter row matching `stage` (group-view button). */
  resetStage(stage: IndexerStage): void {
    if (
      !confirm(
        `Reset all dead-letter rows for stage "${stage}"? The watcher will re-attempt these jobs on its next pass.`,
      )
    ) {
      return;
    }
    this.api.resetDeadLetter({ stage }).subscribe({
      next: () => this.refreshDeadLetter(),
      error: (e) =>
        this.error.set(e?.error?.error ?? e?.message ?? 'Reset failed.'),
    });
  }

  /** Reset a single dead-letter row (list-view per-row button). */
  resetRow(item: IndexerDeadLetterItem): void {
    if (!item.key) {
      // Server stores `key` (mapleId hex or absPath) — without it we can't
      // target a single row without risking a stage-wide wipe. Fall back to
      // refusing rather than guessing.
      this.error.set('Cannot reset this row: missing dedupe key.');
      return;
    }
    this.api.resetDeadLetter({ key: item.key }).subscribe({
      next: () => this.refreshDeadLetter(),
      error: (e) =>
        this.error.set(e?.error?.error ?? e?.message ?? 'Reset failed.'),
    });
  }

  /** Internal: build the list-view fetch observable based on current filter
   * signals. Used both for the initial load and the debounced filter pipe. */
  private fetchList$(): Observable<IndexerDeadLetterPage> {
    this.triageLoading.set(true);
    const stage = this.filterStage();
    const prefix = this.filterErrorPrefix().trim();
    const obs =
      stage === null && prefix === ''
        ? this.api.listDeadLetter(200)
        : this.api.filterDeadLetter({
            stage: stage ?? undefined,
            errorPrefix: prefix === '' ? undefined : prefix,
            limit: 200,
          });
    return obs.pipe(
      catchError(() => of<IndexerDeadLetterPage>({ items: [], total: 0 })),
      tap(() => this.triageLoading.set(false)),
    );
  }

  private loadList(): void {
    this.fetchList$().subscribe((p) => this.deadLetter.set(p.items));
  }

  private loadGroups(): void {
    this.api.groupDeadLetter().subscribe({
      next: (r) => this.deadLetterGroups.set(r.groups),
      error: () => this.deadLetterGroups.set([]),
    });
  }

  /** Status pill for the "Rescan all" button — operator feedback that the
   * walk has been kicked off. Resets to idle a few seconds after success
   * so a long session of clicks doesn't pile up green checkmarks. */
  readonly rescanStatus = signal<'idle' | 'rescanning' | 'queued' | 'failed'>('idle');
  readonly rescanError = signal<string | null>(null);

  /** Walk every registered library RIGHT NOW. The 5-min watcher polling
   * interval makes "I just dropped a memory card and want to see the
   * photos" feel slow — this button is the manual override for that. The
   * server returns immediately; the discover channel populates as the
   * walk runs, so the live status table picks it up on the next tick. */
  rescanAll(): void {
    this.rescanError.set(null);
    this.rescanStatus.set('rescanning');
    this.api.listFolders().subscribe({
      next: (folders) => {
        if (folders.length === 0) {
          this.rescanStatus.set('queued');
          setTimeout(() => {
            if (this.rescanStatus() === 'queued') this.rescanStatus.set('idle');
          }, 2_500);
          return;
        }
        let remaining = folders.length;
        let firstError: string | null = null;
        for (const f of folders) {
          this.api.rescanFolder(f.id).subscribe({
            next: () => {
              remaining--;
              if (remaining === 0) {
                if (firstError) {
                  this.rescanError.set(firstError);
                  this.rescanStatus.set('failed');
                } else {
                  this.rescanStatus.set('queued');
                  setTimeout(() => {
                    if (this.rescanStatus() === 'queued') this.rescanStatus.set('idle');
                  }, 2_500);
                }
              }
            },
            error: (e) => {
              firstError = firstError ?? (e?.error?.error ?? e?.message ?? 'Rescan failed.');
              remaining--;
              if (remaining === 0) {
                this.rescanError.set(firstError);
                this.rescanStatus.set('failed');
              }
            },
          });
        }
      },
      error: (e) => {
        this.rescanError.set(e?.error?.error ?? e?.message ?? 'Could not list folders.');
        this.rescanStatus.set('failed');
      },
    });
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
