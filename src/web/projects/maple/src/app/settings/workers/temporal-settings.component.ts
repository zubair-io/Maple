import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, type Observable, Subject, catchError, of, switchMap, tap } from 'rxjs';
import {
  AuthService,
  type TemporalSettings,
  type TemporalSettingsUpdate,
  WorkersApiService,
  errorMessage,
  MuiButtonComponent,
  MuiInputComponent,
  MuiSettingsRowComponent,
} from '@maple-common';
import { SettingsIconComponent } from '../settings-icon.component';
import {
  connectionView,
  sameTarget,
  summaryLine,
  toUpdate,
  watchConnection,
} from './temporal-settings.vm';

@Component({
  selector: 'maple-temporal-settings',
  standalone: true,
  imports: [MuiSettingsRowComponent, MuiButtonComponent, MuiInputComponent, SettingsIconComponent],
  templateUrl: './temporal-settings.component.html',
  styleUrl: './temporal-settings.component.scss',
  host: { class: 'set-vars set-workers-embedded-panel-host' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemporalSettingsComponent implements OnInit {
  private readonly api = inject(WorkersApiService);
  private readonly auth = inject(AuthService);

  // Every read and save goes through this one switchMap, so starting a save
  // drops any poll still in flight instead of letting it land a stale state.
  private readonly requests = new Subject<Observable<TemporalSettings>>();

  protected readonly settings = signal<TemporalSettings | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  private readonly lastSaved = signal<TemporalSettingsUpdate | null>(null);
  protected readonly address = signal('');
  protected readonly namespace = signal('');
  protected readonly expanded = signal(false);

  protected readonly connection = computed(() => connectionView(this.settings()));
  protected readonly summary = computed(() => summaryLine(this.settings()));
  private readonly update = computed(() => toUpdate(this.address(), this.namespace()));
  protected readonly canSave = computed(() => this.update() !== null);
  protected readonly saved = computed(() => sameTarget(this.update(), this.lastSaved()));
  protected readonly owner = computed(() => this.auth.user()?.role === 'owner');

  constructor() {
    this.requests
      .pipe(
        switchMap((first) =>
          watchConnection(first, () => this.api.getTemporalSettings()).pipe(
            catchError((e: unknown) => {
              this.error.set(errorMessage(e));
              this.loading.set(false);
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((next) => this.adopt(next));
  }

  ngOnInit(): void {
    this.reload();
  }

  protected toggleExpanded(): void {
    const next = !this.expanded();
    this.expanded.set(next);
    if (next && !this.saving()) this.reload();
  }

  protected save(): void {
    const update = this.update();
    const current = this.settings();
    if (!update || !current || !this.owner() || this.saving()) return;
    this.saving.set(true);
    this.lastSaved.set(null);
    this.error.set(null);
    this.requests.next(
      this.api.saveTemporalSettings(update).pipe(
        tap(() => {
          this.lastSaved.set(update);
          this.saving.set(false);
        }),
        catchError((e: unknown) => {
          this.error.set(errorMessage(e));
          this.saving.set(false);
          return of(current);
        }),
      ),
    );
  }

  private reload(): void {
    this.error.set(null);
    this.requests.next(this.api.getTemporalSettings());
  }

  private adopt(next: TemporalSettings): void {
    if (this.settings() === null) {
      this.address.set(next.address);
      this.namespace.set(next.namespace);
    }
    this.settings.set(next);
    this.loading.set(false);
  }
}
