// MuiPagePairing — Maple UI Pages (unified-component-catalog.md §6). App
// Shell with the Pair Device flow filling Content.
//
// Cross-organism wiring: Pair Device's `stepChanged`/`paired` outputs drive
// the Page Header title in Nav, so the title bar always names which step of
// the pairing flow is active.

import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { MuiAppShellComponent } from '../../app-shell/mui-app-shell.component';
import { MuiPageHeaderComponent } from '../../page-header/mui-page-header.component';
import { MuiPairDeviceModalComponent } from '../../pair-device-modal/mui-pair-device-modal.component';

const STEP_TITLES: readonly string[] = ['Enter pairing code', 'Scanning for device', 'Connected'];

@Component({
  selector: 'mui-page-pairing',
  standalone: true,
  imports: [MuiAppShellComponent, MuiPageHeaderComponent, MuiPairDeviceModalComponent],
  templateUrl: './mui-page-pairing.component.html',
  styleUrl: './mui-page-pairing.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPagePairingComponent {
  readonly pairingCode = 'MPL-7F2Q-9X';
  readonly step = signal<number>(0);
  readonly pairedDeviceName = signal<string | null>(null);

  readonly headerTitle = computed<string>(() => STEP_TITLES[this.step()] ?? 'Pairing');

  onStepChanged(step: number): void {
    this.step.set(step);
  }

  onPaired(code: string): void {
    this.pairedDeviceName.set(code);
    this.step.set(2);
  }
}
