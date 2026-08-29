// MuiPairDeviceModal — Maple UI Organisms (Wave W6 Lane B). Three-step
// device pairing flow — Show Code, Scanning, Connected — built from Overlay
// Shell, QR Code, QR Scanner, Progress, Progress Step.
//
// The step sequence is driven entirely by the `step` input: this component
// is presentational and never advances itself except by emitting
// `stepChanged` for the caller to apply. `scanning` is a caller-supplied
// display flag (e.g. "waiting on the other device") — mui-qr-scanner owns
// its own camera lifecycle internally and isn't puppeteered from here.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiOverlayShellComponent } from '../overlay-shell/mui-overlay-shell.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';
import { MuiProgressStepComponent } from '../progress-step/mui-progress-step.component';
import type { MuiProgressStepStatus } from '../progress-step/mui-progress-step.component';
import { MuiQrCodeComponent } from '../qr-code/mui-qr-code.component';
import { MuiQrScannerComponent } from '../qr-scanner/mui-qr-scanner.component';
import { MuiTextComponent } from '../text/mui-text.component';

export const MUI_PAIR_DEVICE_STEPS = ['Show Code', 'Scanning', 'Connected'] as const;

interface MuiPairDeviceStepRow {
  readonly index: number;
  readonly label: (typeof MUI_PAIR_DEVICE_STEPS)[number];
  readonly status: MuiProgressStepStatus;
}

@Component({
  selector: 'mui-pair-device-modal',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiOverlayShellComponent,
    MuiProgressComponent,
    MuiProgressStepComponent,
    MuiQrCodeComponent,
    MuiQrScannerComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-pair-device-modal.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPairDeviceModalComponent {
  readonly open = input<boolean>(false);
  /** 0 = Show Code, 1 = Scanning, 2 = Connected. */
  readonly step = input<number>(0);
  readonly pairingCode = input<string>('');
  readonly scanning = input<boolean>(false);
  readonly connected = input<boolean>(false);

  readonly stepChanged = output<number>();
  readonly paired = output<string>();
  readonly dismissed = output<void>();

  readonly steps = computed<readonly MuiPairDeviceStepRow[]>(() =>
    MUI_PAIR_DEVICE_STEPS.map((label, index) => ({
      index,
      label,
      status: index < this.step() ? 'done' : index === this.step() ? 'active' : 'pending',
    })),
  );

  onScannerCode(): void {
    this.stepChanged.emit(2);
  }

  advance(): void {
    this.stepChanged.emit(Math.min(2, this.step() + 1));
  }

  finish(): void {
    this.paired.emit(this.pairingCode());
  }

  onDismiss(): void {
    this.dismissed.emit();
  }
}
