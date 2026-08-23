// MuiBackupMonitor — Maple UI Organisms, Wave W6 Lane B "Configuration"
// (docs/unified-component-catalog.md §4.8). Backup destination/schedule
// configuration plus a live run progress readout, built from FormField,
// Progress, Banner, Button.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiBannerComponent } from '../banner/mui-banner.component';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';

export type MuiBackupResultVariant = 'success' | 'error';

export interface MuiBackupResult {
  readonly message: string;
  readonly variant: MuiBackupResultVariant;
}

export interface MuiBackupConfig {
  readonly destinationPath: string;
  readonly schedule: string;
}

@Component({
  selector: 'mui-backup-monitor',
  standalone: true,
  imports: [MuiBannerComponent, MuiButtonComponent, MuiFormFieldComponent, MuiProgressComponent],
  templateUrl: './mui-backup-monitor.component.html',
  styleUrl: './mui-backup-monitor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiBackupMonitorComponent {
  readonly destinationPath = model<string>('');
  readonly schedule = model<string>('');
  readonly running = input<boolean>(false);
  /** 0–100, or `null` for an indeterminate run (e.g. still enumerating files). */
  readonly progress = input<number | null>(null);
  readonly lastResult = input<MuiBackupResult | null>(null);

  /** Fires with both current field values whenever either one commits. */
  readonly configChanged = output<MuiBackupConfig>();
  readonly backupStartRequested = output<void>();

  onFieldCommitted(): void {
    this.configChanged.emit({
      destinationPath: this.destinationPath(),
      schedule: this.schedule(),
    });
  }
}
