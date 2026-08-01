// MirrorSettingsComponent — the Mirror/backup panel shown as the "Backup" group
// on the Workers settings page (Ingest / Enrich / Index / Backup). Always-visible
// (not a collapsible row): per-library backup-location config + the live two-stage
// reconcile (scanning → copying) with per-stage counts, the current file, a
// copied-files log, and an error log.
// Backed by GET/PUT /api/folders/:id/mirror, POST /api/mirror/test,
// GET /api/mirror/status, POST /api/mirror/retry-dead, POST /api/mirror/reconcile.

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  BunApiBackendService,
  type ApiFolder,
  type MirrorReconcileProgress,
  errorMessage,
} from '@maple-common';
import { SettingsIconComponent } from '../settings-icon.component';
import { SettingsRowComponent } from '../settings-row.component';

interface MirrorForm {
  path: string;
  enabled: boolean;
}
type SaveState = 'idle' | 'saving' | 'success';
type TestState = 'idle' | 'testing' | 'ok' | 'fail';

@Component({
  selector: 'maple-mirror-settings',
  standalone: true,
  imports: [SettingsIconComponent, SettingsRowComponent],
  templateUrl: './mirror-settings.component.html',
  styleUrl: './mirror-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MirrorSettingsComponent implements OnInit, OnDestroy {
  private readonly backend = inject(BunApiBackendService);

  protected readonly libraries = signal<ApiFolder[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  /** Collapsed by default, matching the stage rows on this page. */
  protected readonly expanded = signal(false);
  protected toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }

  /** True once at least one library has an enabled mirror with a path. */
  protected readonly mirrorActive = computed(() =>
    Object.values(this.forms()).some((m) => m.enabled && m.path.trim().length > 0),
  );

  /** Per-library editable form (one mirror per library in this UI). */
  protected readonly forms = signal<Record<string, MirrorForm>>({});
  protected readonly saveState = signal<Record<string, SaveState>>({});
  protected readonly saveError = signal<Record<string, string | null>>({});
  protected readonly testState = signal<Record<string, TestState>>({});
  protected readonly testMsg = signal<Record<string, string | null>>({});

  /** Standing queue depth (pending waiting to copy / dead-lettered). */
  protected readonly status = signal<{ pending: number; dead: number } | null>(null);
  protected readonly retrying = signal(false);

  /** Backup roots the API has benched for READS after an I/O failure/timeout.
   * Writes still queue and retry — only read load-balancing is paused. */
  protected readonly benchedReads = signal<{ root: string; retryInMs: number }[]>([]);

  /** Whole seconds until a benched root is probed again (for the operator line). */
  protected retrySeconds(ms: number): number {
    return Math.max(1, Math.ceil(ms / 1000));
  }

  /** Live two-stage reconcile progress (null before any run). */
  protected readonly reconcile = signal<MirrorReconcileProgress | null>(null);
  /** True from clicking "Reconcile now" until the run reports idle. */
  protected readonly running = signal(false);
  /** Poll timer that refreshes status while a reconcile is in flight. */
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping status fetches when one runs long. */
  private polling = false;

  /** A reconcile is active when we just kicked one or the server reports a
   * non-idle phase (scanning/copying in the API process). */
  protected reconcileBusy(): boolean {
    return this.running() || (this.reconcile()?.phase ?? 'idle') !== 'idle';
  }

  /** Button label while a run is in flight. */
  protected busyLabel(): string {
    switch (this.reconcile()?.phase) {
      case 'scanning':
        return 'Scanning…';
      case 'copying':
        return 'Copying…';
      default:
        return 'Working…';
    }
  }

  /** Summary status pill text — the active stage, else the mirror config state. */
  protected statusLabel(): string {
    const phase = this.reconcile()?.phase;
    if (phase === 'scanning') return 'Scanning';
    if (phase === 'copying') return 'Copying';
    return this.mirrorActive() ? 'Active' : 'Not configured';
  }
  protected statusColor(): string {
    if ((this.reconcile()?.phase ?? 'idle') !== 'idle') return 'var(--s-accent)';
    return this.mirrorActive() ? 'var(--s-ok)' : 'var(--s-text-dim)';
  }

  /** One-line readout for the panel header (the active stage, else the queue). */
  protected reconcileSummary(): string {
    const r = this.reconcile();
    if (r?.phase === 'scanning') {
      return `Scanning · ${r.scan.scanned} checked · ${r.scan.toCopy} to copy`;
    }
    if (r?.phase === 'copying') {
      const errs = r.copy.errors > 0 ? ` · ${r.copy.errors} failed` : '';
      return `Copying · ${r.copy.copied}/${r.copy.total} · ${r.copy.remaining} left${errs}`;
    }
    const q = this.status();
    if (q && (q.pending > 0 || q.dead > 0)) {
      return `${q.pending} pending · ${q.dead} failed`;
    }
    return this.mirrorActive() ? 'Up to date' : '';
  }

  async ngOnInit(): Promise<void> {
    try {
      const libs = await firstValueFrom(this.backend.listFolders());
      this.libraries.set(libs);
      const forms: Record<string, MirrorForm> = {};
      await Promise.all(
        libs.map(async (lib) => {
          try {
            const res = await firstValueFrom(this.backend.getFolderMirrors(lib.id));
            const first = res.mirrors[0];
            forms[lib.id] = { path: first?.path ?? '', enabled: first?.enabled ?? true };
          } catch {
            forms[lib.id] = { path: '', enabled: true };
          }
        }),
      );
      this.forms.set(forms);
      await this.refreshStatus();
      // If a reconcile is already running server-side (started before this reload,
      // possibly in another tab), reflect it and resume live polling so the UI
      // tracks it to completion instead of a frozen snapshot / stuck button.
      this.resumeIfRunning();
    } catch (e) {
      this.error.set(this.msg(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected pathOf(id: string): string {
    return this.forms()[id]?.path ?? '';
  }
  protected enabledOf(id: string): boolean {
    return this.forms()[id]?.enabled ?? true;
  }
  protected saveStateOf(id: string): SaveState {
    return this.saveState()[id] ?? 'idle';
  }
  protected saveErrorOf(id: string): string | null {
    return this.saveError()[id] ?? null;
  }
  protected testStateOf(id: string): TestState {
    return this.testState()[id] ?? 'idle';
  }
  protected testMsgOf(id: string): string | null {
    return this.testMsg()[id] ?? null;
  }

  protected setPath(id: string, value: string): void {
    this.forms.update((m) => ({ ...m, [id]: { ...m[id], path: value } }));
    this.testState.update((m) => ({ ...m, [id]: 'idle' }));
    this.saveState.update((m) => ({ ...m, [id]: 'idle' }));
  }

  protected setEnabled(id: string, value: boolean): void {
    this.forms.update((m) => ({ ...m, [id]: { ...m[id], enabled: value } }));
    this.saveState.update((m) => ({ ...m, [id]: 'idle' }));
  }

  protected async test(id: string): Promise<void> {
    const p = this.pathOf(id).trim();
    if (!p) return;
    this.testState.update((m) => ({ ...m, [id]: 'testing' }));
    this.testMsg.update((m) => ({ ...m, [id]: null }));
    try {
      const res = await firstValueFrom(this.backend.testMirrorPath(p));
      if (res.ok) {
        this.testState.update((m) => ({ ...m, [id]: 'ok' }));
        this.testMsg.update((m) => ({ ...m, [id]: res.path ?? p }));
      } else {
        this.testState.update((m) => ({ ...m, [id]: 'fail' }));
        this.testMsg.update((m) => ({ ...m, [id]: res.error ?? 'Not a usable directory.' }));
      }
    } catch (e) {
      this.testState.update((m) => ({ ...m, [id]: 'fail' }));
      this.testMsg.update((m) => ({ ...m, [id]: this.msg(e) }));
    }
  }

  protected async save(id: string): Promise<void> {
    const form = this.forms()[id];
    if (!form) return;
    const path = form.path.trim();
    const mirrors = path ? [{ path, enabled: form.enabled }] : [];
    this.saveState.update((m) => ({ ...m, [id]: 'saving' }));
    this.saveError.update((m) => ({ ...m, [id]: null }));
    try {
      await firstValueFrom(this.backend.setFolderMirrors(id, mirrors));
      this.saveState.update((m) => ({ ...m, [id]: 'success' }));
      await this.refreshStatus();
    } catch (e) {
      this.saveState.update((m) => ({ ...m, [id]: 'idle' }));
      this.saveError.update((m) => ({ ...m, [id]: this.msg(e) }));
    }
  }

  protected async retryDead(): Promise<void> {
    this.retrying.set(true);
    try {
      await firstValueFrom(this.backend.retryDeadMirrors());
      await this.refreshStatus();
    } catch (e) {
      this.error.set(this.msg(e));
    } finally {
      this.retrying.set(false);
    }
  }

  /** Kick a full reconcile (scan → copy), then poll status so the operator can
   * watch the stages move (current file + per-stage counts). */
  protected async reconcileNow(): Promise<void> {
    this.error.set(null);
    this.running.set(true);
    try {
      const res = await firstValueFrom(this.backend.runMirrorReconcile());
      if (!res.started && res.reason) this.error.set(`Reconcile not started: ${res.reason}`);
      await this.refreshStatus();
      // Poll only while a run is actually in flight; a tiny library can finish
      // before the first refresh, leaving nothing to watch.
      if ((this.reconcile()?.phase ?? 'idle') !== 'idle') {
        this.startPolling();
      } else {
        this.running.set(false);
      }
    } catch (e) {
      this.error.set(this.msg(e));
      this.running.set(false);
    }
  }

  private resumeIfRunning(): void {
    if ((this.reconcile()?.phase ?? 'idle') !== 'idle') {
      this.running.set(true);
      this.startPolling();
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      // Skip a tick while the previous refresh is still in flight — never let
      // slow status fetches stack into overlapping requests.
      if (this.polling) return;
      this.polling = true;
      void (async () => {
        try {
          await this.refreshStatus();
          if ((this.reconcile()?.phase ?? 'idle') === 'idle') {
            this.stopPolling();
            this.running.set(false);
          }
        } finally {
          this.polling = false;
        }
      })();
    }, 1200);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  private async refreshStatus(): Promise<void> {
    try {
      const res = await firstValueFrom(this.backend.getMirrorStatus());
      this.status.set(res.queue);
      this.benchedReads.set(res.reads?.benched ?? []);
      // Treat a "never run" idle snapshot (no timestamps, no errors) as null so
      // the "not run yet" hint shows until a real reconcile has happened.
      const r = res.reconcile;
      const neverRun =
        !r || (r.phase === 'idle' && !r.startedAt && !r.finishedAt && r.errorLog.length === 0);
      this.reconcile.set(neverRun ? null : r);
    } catch {
      // Status is informational — a fetch failure shouldn't surface an error banner.
    }
  }

  private msg(e: unknown): string {
    return errorMessage(e);
  }
}
