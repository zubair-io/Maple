// MuiProgressStep — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). One step of a wizard, built from Text, Progress, Button.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';
import { MuiTextComponent } from '../text/mui-text.component';

export type MuiProgressStepStatus = 'pending' | 'active' | 'done';

@Component({
  selector: 'mui-progress-step',
  standalone: true,
  imports: [MuiButtonComponent, MuiProgressComponent, MuiTextComponent],
  templateUrl: './mui-progress-step.component.html',
  styleUrl: './mui-progress-step.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiProgressStepComponent {
  readonly index = input.required<number>();
  readonly label = input.required<string>();
  readonly status = input<MuiProgressStepStatus>('pending');
  readonly continueLabel = input<string>('Continue');

  readonly continued = output<void>();

  readonly progressValue = computed<number | null>(() => {
    switch (this.status()) {
      case 'done':
        return 100;
      case 'active':
        return null; // indeterminate — still running
      default:
        return 0;
    }
  });
}
