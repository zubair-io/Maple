import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, firstValueFrom, of, switchMap, timer } from 'rxjs';
import {
  MuiButtonComponent,
  MuiCheckboxComponent,
  MuiInputComponent,
  MuiLinkComponent,
  errorMessage,
} from '@maple-common';
import { ManagedHttpsService, type ManagedHttpsResponse } from './managed-https.service';

@Component({
  selector: 'maple-managed-https',
  standalone: true,
  imports: [MuiButtonComponent, MuiCheckboxComponent, MuiInputComponent, MuiLinkComponent],
  templateUrl: './managed-https.component.html',
  styleUrl: './managed-https.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ManagedHttpsComponent implements OnInit {
  private readonly api = inject(ManagedHttpsService);
  private readonly destroyRef = inject(DestroyRef);
  private seeded = false;
  protected readonly response = signal<ManagedHttpsResponse | null>(null);
  protected readonly enabled = signal(false);
  protected readonly hostname = signal('');
  protected readonly port = signal('3443');
  protected readonly email = signal('');
  protected readonly zoneId = signal('');
  protected readonly token = signal('');
  protected readonly http3 = signal(true);
  protected readonly terms = signal(false);
  protected readonly clearToken = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly saved = signal(false);
  protected readonly statusText = computed(() => {
    const status = this.response()?.status;
    if (!status) return 'Loading certificate status…';
    const labels = {
      disabled: 'Disabled',
      pending: 'Waiting to start',
      issuing: 'Obtaining certificate',
      ready: 'HTTPS ready',
      error: 'Needs attention',
    };
    return labels[status.state];
  });
  protected readonly expires = computed(() => {
    const expiry = this.response()?.status.expires_at;
    return expiry ? new Date(expiry).toLocaleString() : '';
  });
  protected readonly retry = computed(() => {
    const value = this.response()?.status.retry_at;
    return value ? new Date(value).toLocaleString() : '';
  });

  ngOnInit(): void {
    timer(0, 10_000)
      .pipe(
        switchMap(() =>
          this.api.load().pipe(
            catchError((err: unknown) => {
              // A missed poll after the form is seeded (e.g. the brief
              // reconnect during certificate replacement) is not a save error.
              if (!this.seeded) this.error.set(errorMessage(err));
              return of(null);
            }),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((response) => {
        if (!response) return;
        this.response.set(response);
        if (this.seeded) return;
        this.seeded = true;
        const cfg = response.config;
        this.enabled.set(cfg.enabled);
        this.hostname.set(cfg.hostname);
        this.port.set(String(cfg.port));
        this.email.set(cfg.email);
        this.zoneId.set(cfg.zone_id);
        this.http3.set(cfg.http3);
        this.terms.set(cfg.terms_agreed);
      });
  }

  protected async save(): Promise<void> {
    this.error.set('');
    this.saved.set(false);
    const port = Number(this.port());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.error.set('Enter an HTTPS port between 1 and 65535.');
      return;
    }
    this.saving.set(true);
    try {
      const response = await firstValueFrom(
        this.api.save({
          enabled: this.enabled(),
          hostname: this.hostname(),
          port,
          email: this.email(),
          zone_id: this.zoneId(),
          http3: this.http3(),
          terms_agreed: this.terms(),
          // A token typed into the field is the operator's most recent intent
          // and wins over a stale "remove saved token" tick.
          ...(this.token().trim()
            ? { api_token: this.token().trim() }
            : this.clearToken()
              ? { api_token: null }
              : {}),
        }),
      );
      this.response.set(response);
      this.token.set('');
      this.clearToken.set(false);
      this.saved.set(true);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.saving.set(false);
    }
  }
}
