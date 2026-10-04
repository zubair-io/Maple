import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  Subject,
  catchError,
  firstValueFrom,
  forkJoin,
  map,
  merge,
  of,
  switchMap,
  timer,
} from 'rxjs';
import {
  AuthService,
  BunApiBackendService,
  CloudBackupService,
  errorMessage,
  MuiButtonComponent,
  MuiCheckboxComponent,
  MuiInputComponent,
  MuiSelectComponent,
  type ApiFolder,
  type BackupDestination,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { GoogleBackupComponent } from './google-backup.component';
import { BackupRecoveryComponent } from './backup-recovery.component';

type BackupView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; folders: ApiFolder[]; destinations: BackupDestination[] };

@Component({
  selector: 'maple-backup-settings',
  standalone: true,
  imports: [
    RouterLink,
    SettingsShellComponent,
    GoogleBackupComponent,
    BackupRecoveryComponent,
    MuiButtonComponent,
    MuiCheckboxComponent,
    MuiInputComponent,
    MuiSelectComponent,
  ],
  templateUrl: './backup.component.html',
  styleUrl: './backup.component.scss',
  host: { class: 'set-vars set-page-host' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BackupComponent {
  private readonly api = inject(CloudBackupService);
  private readonly libraryApi = inject(BunApiBackendService);
  private readonly reload = new Subject<void>();
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  protected readonly owner = computed(() => this.auth.user()?.role === 'owner');
  protected readonly view = toSignal(
    merge(of(0), timer(15_000, 15_000), this.reload).pipe(
      switchMap(() =>
        this.auth.user()?.role !== 'owner'
          ? of<BackupView>({ kind: 'loading' })
          : forkJoin({
              folders: this.libraryApi.listFolders(),
              destinations: this.api.destinations(),
            }).pipe(
              map(
                ({ folders, destinations }): BackupView => ({
                  kind: 'ready',
                  folders,
                  destinations,
                }),
              ),
              catchError((error: unknown) =>
                of<BackupView>({ kind: 'error', message: errorMessage(error) }),
              ),
            ),
      ),
    ),
    { initialValue: { kind: 'loading' } as BackupView },
  );
  protected readonly library = signal('');
  protected readonly kind = signal<BackupDestination['kind']>('folder');
  protected readonly name = signal('');
  protected readonly path = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly expanded = signal<string | null>(
    this.route.snapshot.queryParamMap.get('connected'),
  );
  protected readonly removing = signal<string | null>(null);
  protected readonly kinds = [
    { value: 'folder', label: 'Another folder' },
    { value: 'google-drive', label: 'Google Drive' },
  ];
  protected readonly libraries = computed(() => {
    const view = this.view();
    return [
      { value: '', label: 'Select a library' },
      ...(view.kind === 'ready'
        ? view.folders.map((folder) => ({ value: folder.id, label: folder.label }))
        : []),
    ];
  });
  protected readonly canAdd = computed(
    () => !this.busy() && !!this.library() && (this.kind() !== 'folder' || !!this.path().trim()),
  );

  constructor() {
    const oauthError = this.route.snapshot.queryParamMap.get('googleError');
    if (!oauthError) return;
    this.error.set(oauthError.slice(0, 1024));
    const url = new URL(window.location.href);
    url.searchParams.delete('googleError');
    window.history.replaceState(window.history.state, '', url.href);
  }

  protected refresh(): void {
    this.reload.next();
  }
  protected setKind(value: string): void {
    if (value === 'folder' || value === 'google-drive') this.kind.set(value);
  }
  protected libraryName(id: string): string {
    const view = this.view();
    return view.kind === 'ready'
      ? (view.folders.find((folder) => folder.id === id)?.label ?? id)
      : id;
  }
  protected async add(): Promise<void> {
    if (!this.canAdd()) return;
    await this.perform(async () => {
      const destination = await firstValueFrom(
        this.api.createDestination({
          libraryId: this.library(),
          kind: this.kind(),
          name: this.name().trim() || (this.kind() === 'folder' ? 'Folder mirror' : 'Google Drive'),
          ...(this.kind() === 'folder' ? { path: this.path().trim() } : {}),
        }),
      );
      this.expanded.set(destination.id);
      this.path.set('');
      this.name.set('');
      this.message.set('Destination added.');
    });
  }
  protected async enabled(destination: BackupDestination, enabled: boolean): Promise<void> {
    await this.perform(async () => {
      await firstValueFrom(this.api.updateDestination(destination.id, { enabled }));
    });
  }
  protected async retry(destination: BackupDestination): Promise<void> {
    await this.perform(async () => {
      await firstValueFrom(this.api.retryDestination(destination.id));
      this.message.set('Pending work is eligible for retry.');
    });
  }
  protected async remove(destination: BackupDestination): Promise<void> {
    if (this.removing() !== destination.id) return;
    await this.perform(async () => {
      await firstValueFrom(this.api.removeDestination(destination.id));
      this.removing.set(null);
      this.message.set('Destination disconnected from this library. Remote files were retained.');
    });
  }
  protected toggle(id: string): void {
    this.expanded.update((current) => (current === id ? null : id));
  }
  private async perform(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      await action();
      this.refresh();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
