import { SettingsAction } from '../settings-action';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { catchError, firstValueFrom, map, merge, of, Subject, switchMap } from 'rxjs';
import {
  CloudBackupService,
  errorMessage,
  MuiButtonComponent,
  MuiCheckboxComponent,
  MuiInputComponent,
  MuiSelectComponent,
  type GoogleBackupConfig,
} from '@maple-common';

type ConfigView =
  | { kind: 'ready'; config: GoogleBackupConfig }
  | { kind: 'error'; message: string }
  | { kind: 'loading' };

@Component({
  selector: 'maple-google-backup',
  standalone: true,
  imports: [
    RouterLink,
    MuiButtonComponent,
    MuiCheckboxComponent,
    MuiInputComponent,
    MuiSelectComponent,
  ],
  templateUrl: './google-backup.component.html',
  styleUrl: './google-backup.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GoogleBackupComponent {
  readonly destinationId = input.required<string>();
  readonly changed = output<void>();
  private readonly api = inject(CloudBackupService);
  private readonly reload = new Subject<void>();
  protected readonly view = toSignal(
    merge(toObservable(this.destinationId), this.reload).pipe(
      switchMap(() =>
        this.api.googleConfig(this.destinationId()).pipe(
          map((config): ConfigView => ({ kind: 'ready', config })),
          catchError((error: unknown) =>
            of<ConfigView>({ kind: 'error', message: errorMessage(error) }),
          ),
        ),
      ),
    ),
    { initialValue: { kind: 'loading' } as ConfigView },
  );
  protected readonly config = computed(() => {
    const view = this.view();
    return view.kind === 'ready' ? view.config : null;
  });
  protected readonly bringOwn = signal(false);
  protected readonly clientId = signal('');
  protected readonly secret = signal('');
  protected readonly callbackMode = signal<'relay' | 'direct'>('relay');
  protected readonly rootId = signal('');
  private readonly actions = new SettingsAction(() => {
    this.changed.emit();
    this.refresh();
  });
  protected readonly busy = this.actions.busy;
  protected readonly error = this.actions.error;
  protected readonly message = this.actions.message;
  protected readonly modes = [
    { value: 'relay', label: 'Hosted callback proxy' },
    { value: 'direct', label: 'Direct to this server' },
  ];
  protected readonly canSave = computed(
    () =>
      this.bringOwn() &&
      !!this.clientId().trim() &&
      (!!this.secret().trim() ||
        (!!this.config()?.clientSecretSet && this.clientId().trim() === this.config()?.clientId)),
  );
  protected readonly canConnect = computed(
    () => this.canSave() && !!this.config()?.callbackUrl && !this.busy(),
  );
  private seededConfig: GoogleBackupConfig | null = null;

  constructor() {
    effect(() => {
      const config = this.config();
      if (!config || this.seededConfig === config) return;
      this.seededConfig = config;
      this.bringOwn.set(!!config.clientId);
      this.clientId.set(config.clientId);
      this.secret.set('');
      this.callbackMode.set(config.callbackMode);
      this.rootId.set(config.rootId ?? '');
    });
  }
  protected setMode(mode: string): void {
    if (mode === 'relay' || mode === 'direct') this.callbackMode.set(mode);
  }
  protected refresh(): void {
    this.reload.next();
  }
  protected async save(connect = false): Promise<void> {
    if (!this.canSave() || this.busy() || (connect && !this.canConnect())) return;
    await this.actions.run(async () => {
      await firstValueFrom(
        this.api.saveGoogleConfig(this.destinationId(), {
          clientId: this.clientId().trim(),
          callbackMode: this.callbackMode(),
          ...(this.secret().trim() ? { clientSecret: this.secret().trim() } : {}),
        }),
      );
      this.secret.set('');
      if (!connect) {
        this.message.set('Google application settings saved.');
        return;
      }
      const response = await firstValueFrom(this.api.connectGoogle(this.destinationId()));
      const url = new URL(response.authorizationUrl);
      const allowed =
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        (url.hostname === 'accounts.google.com' ||
          (url.hostname === 'mapleeditor.com' && url.pathname === '/connect/google-drive'));
      if (!allowed) throw new Error('The server returned an invalid Google authorization URL.');
      window.location.assign(url.href);
    });
  }
  protected async attachRoot(): Promise<void> {
    const config = this.config();
    if (!this.rootId().trim() || !config?.connected) return;
    await this.actions.run(async () => {
      await firstValueFrom(
        this.api.saveGoogleConfig(this.destinationId(), {
          clientId: config.clientId,
          callbackMode: config.callbackMode,
          rootId: this.rootId().trim(),
        }),
      );
      this.message.set('Existing backup root verified and attached.');
    });
  }
  protected async createRoot(): Promise<void> {
    await this.actions.run(async () => {
      await firstValueFrom(this.api.createGoogleRoot(this.destinationId()));
      this.message.set(
        'Maple Photo Backup folder created. Resume cloud-backup in Workers to begin.',
      );
    });
  }
  protected async disconnect(clear = false): Promise<void> {
    await this.actions.run(async () => {
      await firstValueFrom(this.api.disconnectGoogle(this.destinationId()));
      if (clear)
        await firstValueFrom(
          this.api.saveGoogleConfig(this.destinationId(), {
            clientId: '',
            clientSecret: null,
            callbackMode: this.callbackMode(),
          }),
        );
      this.secret.set('');
      this.message.set(
        clear
          ? 'Google credentials cleared. Backup files remain.'
          : 'Google disconnected. Backup files and pending purge obligations remain.',
      );
    });
  }
  protected async copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.message.set('Callback URL copied.');
    } catch {
      this.error.set('Clipboard access was denied. Select and copy the displayed URL.');
    }
  }
}
