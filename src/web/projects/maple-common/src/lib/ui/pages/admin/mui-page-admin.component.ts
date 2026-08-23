// MuiPageAdmin — Maple UI Pages (unified-component-catalog.md §6). Settings
// Shell: a section list in Nav, and — per the selected section — Pipeline
// Monitor, Setup Wizard, Backup Monitor, or Diagnostics in the Pane.
//
// Cross-organism wiring: the Nav section list drives which organism renders
// in the Pane, same shape as the Settings page; a stage pause/retry from
// Pipeline Monitor is applied back into that organism's own stage data.

import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { MuiSettingsShellComponent } from '../../settings-shell/mui-settings-shell.component';
import { MuiListRowComponent } from '../../list-row/mui-list-row.component';
import type { MapleIconName } from '../../icon/mui-icon.component';
import { MuiPipelineMonitorComponent } from '../../pipeline-monitor/mui-pipeline-monitor.component';
import type { MuiPipelineStage } from '../../pipeline-monitor/mui-pipeline-monitor.component';
import { MuiSetupWizardComponent } from '../../setup-wizard/mui-setup-wizard.component';
import { MuiWizardStepDirective } from '../../setup-wizard/mui-wizard-step.directive';
import { MuiFormFieldComponent } from '../../form-field/mui-form-field.component';
import { MuiBackupMonitorComponent } from '../../backup-monitor/mui-backup-monitor.component';
import type {
  MuiBackupResult,
  MuiBackupConfig,
} from '../../backup-monitor/mui-backup-monitor.component';
import { MuiDiagnosticsComponent } from '../../diagnostics/mui-diagnostics.component';
import type { MuiDiagnosticCheck } from '../../diagnostics/mui-diagnostics.component';

interface AdminNavSection {
  readonly id: string;
  readonly label: string;
  readonly icon: MapleIconName;
}

const NAV_SECTIONS: readonly AdminNavSection[] = [
  { id: 'pipeline', label: 'Pipeline', icon: 'gear' },
  { id: 'setup', label: 'Setup', icon: 'plus' },
  { id: 'backup', label: 'Backup', icon: 'history' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'scope' },
];

@Component({
  selector: 'mui-page-admin',
  standalone: true,
  imports: [
    MuiSettingsShellComponent,
    MuiListRowComponent,
    MuiPipelineMonitorComponent,
    MuiSetupWizardComponent,
    MuiWizardStepDirective,
    MuiFormFieldComponent,
    MuiBackupMonitorComponent,
    MuiDiagnosticsComponent,
  ],
  templateUrl: './mui-page-admin.component.html',
  styleUrl: './mui-page-admin.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPageAdminComponent {
  readonly navSections = NAV_SECTIONS;
  readonly activeSectionId = signal<string>('pipeline');

  readonly pipelineStages = signal<readonly MuiPipelineStage[]>([
    { id: 'exif', name: 'exif', status: 'done', processed: 12480, total: 12480 },
    { id: 'thumb', name: 'thumb', status: 'running', processed: 9963, total: 12480 },
    { id: 'describe', name: 'describe', status: 'error', processed: 4211, total: 12480 },
  ]);

  readonly wizardSteps: readonly string[] = ['Library location', 'Worker pipeline', 'Backup'];
  readonly wizardIndex = signal<number>(0);
  readonly wizardLibraryPath = signal<string>('');
  readonly wizardCanGoNext = signal<boolean>(true);

  readonly backupRunning = signal<boolean>(false);
  readonly backupProgress = signal<number | null>(null);
  readonly backupLastResult = signal<MuiBackupResult | null>(null);
  readonly backupDestinationPath = signal<string>('/Volumes/Backup');
  readonly backupSchedule = signal<string>('Nightly');

  readonly diagnosticChecks = signal<readonly MuiDiagnosticCheck[]>([
    { id: 'xmp-roundtrip', label: 'XMP sidecar round-trip', status: 'pass' },
    { id: 'raw-core-ffi', label: 'raw-core FFI link', status: 'fail' },
    { id: 'meili-index', label: 'Meilisearch index reachable', status: 'pending' },
  ]);
  readonly diagnosticsRunning = signal<boolean>(false);
  readonly diagnosticOutput = signal<string>('');

  onStagePauseToggled(id: string): void {
    this.pipelineStages.update((stages) =>
      stages.map((stage) =>
        stage.id === id
          ? { ...stage, status: stage.status === 'paused' ? 'running' : 'paused' }
          : stage,
      ),
    );
  }

  onStageRetried(id: string): void {
    this.pipelineStages.update((stages) =>
      stages.map((stage) => (stage.id === id ? { ...stage, status: 'running' } : stage)),
    );
  }

  onWizardStepChanged(index: number): void {
    this.wizardIndex.set(index);
  }

  onWizardFinished(): void {
    this.wizardIndex.set(0);
  }

  onBackupConfigChanged(config: MuiBackupConfig): void {
    this.backupDestinationPath.set(config.destinationPath);
    this.backupSchedule.set(config.schedule);
  }

  onBackupStartRequested(): void {
    this.backupRunning.set(true);
    this.backupProgress.set(0);
    this.backupLastResult.set(null);
  }

  onDiagnosticsRun(): void {
    this.diagnosticsRunning.set(true);
    this.diagnosticChecks.update((checks) => checks.map((c) => ({ ...c, status: 'pending' })));
    this.diagnosticOutput.set('Running…');
  }
}
