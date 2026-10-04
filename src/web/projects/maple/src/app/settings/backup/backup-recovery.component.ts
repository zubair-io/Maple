import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import {
  catchError,
  firstValueFrom,
  forkJoin,
  map,
  merge,
  of,
  Subject,
  startWith,
  switchMap,
  takeWhile,
  timer,
} from 'rxjs';
import {
  CloudBackupService,
  errorMessage,
  MuiButtonComponent,
  MuiCheckboxComponent,
  MuiInputComponent,
  MuiSelectComponent,
  type BackupCatalog,
  type BackupRestoreJob,
  type BackupRestorePreview,
  type BackupRestoreRequest,
} from '@maple-common';

type CatalogView =
  | { kind: 'ready'; catalog: BackupCatalog; jobs: BackupRestoreJob[] }
  | { kind: 'error'; message: string }
  | { kind: 'loading' };
type JobView = { kind: 'ready'; job: BackupRestoreJob } | { kind: 'error'; message: string } | null;

@Component({
  selector: 'maple-backup-recovery',
  standalone: true,
  imports: [MuiButtonComponent, MuiCheckboxComponent, MuiInputComponent, MuiSelectComponent],
  templateUrl: './backup-recovery.component.html',
  styleUrl: './backup-recovery.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BackupRecoveryComponent {
  readonly destinationId = input.required<string>();
  private readonly api = inject(CloudBackupService);
  private readonly reload = new Subject<void>();
  protected readonly view = toSignal(
    merge(toObservable(this.destinationId), this.reload).pipe(
      switchMap(() =>
        forkJoin({
          catalog: this.api.catalog(this.destinationId()),
          jobs: this.api.restoreJobs(this.destinationId()),
        }).pipe(
          map(({ catalog, jobs }): CatalogView => ({ kind: 'ready', catalog, jobs })),
          catchError((error: unknown) =>
            of<CatalogView>({ kind: 'error', message: errorMessage(error) }),
          ),
        ),
      ),
    ),
    { initialValue: { kind: 'loading' } as CatalogView },
  );
  protected readonly targetPath = signal('');
  protected readonly includeTrash = signal(false);
  protected readonly selection = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly preview = signal<{
    request: BackupRestoreRequest;
    result: BackupRestorePreview;
  } | null>(null);
  protected readonly jobId = signal<string | null>(null);
  private readonly reloadJob = new Subject<void>();
  protected readonly jobView = toSignal(
    merge(toObservable(this.jobId), this.reloadJob.pipe(map(() => this.jobId()))).pipe(
      switchMap((id) =>
        !id
          ? of<JobView>(null)
          : merge(of(0), timer(2000, 2000)).pipe(
              switchMap(() =>
                this.api.restoreJob(id).pipe(
                  map((job): JobView => ({ kind: 'ready', job })),
                  catchError((error: unknown) =>
                    of<JobView>({ kind: 'error', message: errorMessage(error) }),
                  ),
                ),
              ),
              takeWhile(
                (view) =>
                  !view ||
                  view.kind === 'error' ||
                  view.job.status === 'queued' ||
                  view.job.status === 'running',
                true,
              ),
              startWith(null),
            ),
      ),
    ),
    { initialValue: null },
  );
  protected readonly running = computed(() => {
    const view = this.jobView();
    return (
      !!this.jobId() &&
      (!view ||
        view.kind === 'error' ||
        view.job.status === 'queued' ||
        view.job.status === 'running')
    );
  });
  protected readonly canResume = computed(() => {
    const view = this.jobView();
    return (
      !this.busy() &&
      view?.kind === 'ready' &&
      view.job.id === this.jobId() &&
      (view.job.status === 'failed' || view.job.status === 'cancelled')
    );
  });
  protected readonly historyOptions = computed(() => {
    const view = this.view();
    const entries =
      view.kind !== 'ready'
        ? []
        : view.catalog.entries.filter(
            (entry) =>
              !view.catalog.purges.some(
                (purge) => purge.entryId === entry.entryId && purge.sequence >= entry.sequence,
              ),
          );
    return [
      { value: '', label: 'Current library' },
      ...entries.map((entry) => ({
        value: JSON.stringify({ entryId: entry.entryId, sequence: entry.sequence }),
        label: `${entry.originalPath} · generation ${entry.sequence} · ${entry.state === 'trash' ? 'Trash' : 'Active'}`,
      })),
    ];
  });
  protected readonly canRestore = computed(() => {
    const preview = this.preview();
    return (
      !!preview &&
      !this.busy() &&
      !this.running() &&
      preview.result.files > 0 &&
      preview.result.gaps.length === 0 &&
      this.request() !== null &&
      JSON.stringify(preview.request) === JSON.stringify(this.request())
    );
  });
  constructor() {
    effect(() => {
      const view = this.view();
      if (view.kind !== 'ready' || this.jobId()) return;
      const active = view.jobs.find((job) => job.status === 'queued' || job.status === 'running');
      if (active) this.jobId.set(active.id);
    });
  }
  protected viewJob(id: string): void {
    this.preview.set(null);
    this.jobId.set(id);
  }
  protected refresh(): void {
    this.preview.set(null);
    this.reload.next();
  }
  private request(): BackupRestoreRequest | null {
    const view = this.view();
    const entry =
      view.kind === 'ready'
        ? view.catalog.entries.find(
            (candidate) =>
              JSON.stringify({ entryId: candidate.entryId, sequence: candidate.sequence }) ===
              this.selection(),
          )
        : undefined;
    if (
      this.selection() &&
      (!entry ||
        view.kind !== 'ready' ||
        view.catalog.purges.some(
          (purge) => purge.entryId === entry.entryId && purge.sequence >= entry.sequence,
        ))
    )
      return null;
    return {
      targetPath: this.targetPath().trim(),
      includeTrash: this.includeTrash(),
      ...(entry ? { entryId: entry.entryId, sequence: entry.sequence } : {}),
    };
  }
  protected async inspect(): Promise<void> {
    if (!this.targetPath().trim() || this.busy() || this.running()) return;
    this.busy.set(true);
    this.error.set('');
    this.preview.set(null);
    try {
      const request = this.request();
      if (!request)
        throw new Error(
          'The selected generation is unavailable. Refresh the catalog and select a recoverable generation.',
        );
      const result = await firstValueFrom(this.api.previewRestore(this.destinationId(), request));
      this.preview.set({ request, result });
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
  protected async restore(): Promise<void> {
    if (!this.canRestore()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const request = this.request();
      if (!request)
        throw new Error(
          'The selected generation is unavailable. Refresh the catalog before restoring.',
        );
      const response = await firstValueFrom(this.api.restore(this.destinationId(), request));
      this.jobId.set(response.jobId);
      this.preview.set(null);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
  protected async cancel(): Promise<void> {
    const id = this.jobId();
    if (!id || !this.running() || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await firstValueFrom(this.api.cancelRestore(id));
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
  protected async resume(): Promise<void> {
    const id = this.jobId();
    if (!id || !this.canResume()) return;
    this.busy.set(true);
    this.error.set('');
    this.preview.set(null);
    try {
      await firstValueFrom(this.api.resumeRestore(this.destinationId(), id));
      this.reloadJob.next();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
