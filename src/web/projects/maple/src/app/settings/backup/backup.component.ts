// BackupComponent — `/settings/backup` (owner-gated). Hosts the Mirror/backup
// panel in its own Settings section (moved out of the Workers page): per-library
// backup-location config + the live two-stage reconcile (scan → copy) with the
// current file, a copied-files log, and an error log.

import { ChangeDetectionStrategy, Component } from '@angular/core';
import { SettingsShellComponent } from '../settings-shell.component';
import { MirrorSettingsComponent } from '../workers/mirror-settings.component';

@Component({
  selector: 'maple-backup-settings',
  standalone: true,
  imports: [SettingsShellComponent, MirrorSettingsComponent],
  templateUrl: './backup.component.html',
  styleUrl: './backup.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BackupComponent {}
