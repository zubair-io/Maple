import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, catchError, exhaustMap, interval, startWith } from 'rxjs';
import {
  DbBackupService,
  type DbBackupPolicy,
  type DbBackupSettings,
  MuiButtonComponent,
  MuiCheckboxComponent,
  MuiInputComponent,
} from '@maple-common';

@Component({
  selector: 'maple-db-backup-settings',
  standalone: true,
  imports: [DatePipe, DecimalPipe, MuiButtonComponent, MuiCheckboxComponent, MuiInputComponent],
  templateUrl: './db-backup.component.html',
  styleUrl: './db-backup.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DbBackupComponent implements OnInit {
  private readonly api = inject(DbBackupService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly settings = signal<DbBackupSettings | null>(null);
  protected readonly policy = signal<DbBackupPolicy | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal('');
  protected readonly counts = [
    { key: 'hour', label: 'Daily backup hour (server local time)', max: 23 },
    { key: 'daily', label: 'Daily retention (days)', max: 1000 },
    { key: 'weekly', label: 'Weekly retention (weeks)', max: 1000 },
    { key: 'monthly', label: 'Monthly retention (months)', max: 1000 },
    { key: 'yearly', label: 'Yearly retention (years)', max: 1000 },
  ] as const;

  ngOnInit(): void {
    interval(5000)
      .pipe(
        startWith(0),
        exhaustMap(() =>
          this.api.settings().pipe(
            catchError((error: HttpErrorResponse) => {
              this.error.set(error.error?.error ?? 'Could not load database backup status.');
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((settings) => {
        this.settings.set(settings);
        if (!this.policy()) this.policy.set(settings.policy);
      });
  }

  protected edit(patch: Partial<DbBackupPolicy>): void {
    this.policy.update((policy) => (policy ? { ...policy, ...patch } : null));
    this.notice.set('');
  }

  protected number(value: number): string {
    return String(value);
  }
  protected editCount(
    key: 'hour' | 'daily' | 'weekly' | 'monthly' | 'yearly',
    value: string,
  ): void {
    this.edit({ [key]: value.trim() ? Number(value) : NaN });
  }

  protected save(): void {
    const policy = this.policy();
    if (!policy) return;
    if (
      this.counts.some(
        (field) =>
          !Number.isInteger(policy[field.key]) ||
          policy[field.key] < 0 ||
          policy[field.key] > field.max,
      )
    ) {
      this.error.set('Enter whole numbers within the indicated ranges.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.api
      .save(policy)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (settings) => {
          this.settings.set(settings);
          this.policy.set(settings.policy);
          this.busy.set(false);
          this.notice.set('Backup settings saved.');
        },
        error: (error: HttpErrorResponse) => {
          this.busy.set(false);
          this.error.set(error.error?.error ?? 'Could not save backup settings.');
        },
      });
  }

  protected start(): void {
    this.busy.set(true);
    this.error.set(null);
    this.api
      .start()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.settings.update((settings) => (settings ? { ...settings, running: true } : null));
          this.notice.set('Backup started using saved settings.');
        },
        error: (error: HttpErrorResponse) => {
          this.busy.set(false);
          this.error.set(error.error?.error ?? 'Could not start backup.');
        },
      });
  }
}
