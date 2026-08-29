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
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiProgressStepComponent {
  readonly index = input.required<number>();
  readonly label = input.required<string>();
  readonly status = input<MuiProgressStepStatus>('pending');
  readonly continueLabel = input<string>('Continue');

  readonly continued = output<void>();

  readonly indexClasses = computed(() => {
    const active = this.status() === 'active' || this.status() === 'done';
    const state = active ? 'bg-primary text-text-main' : 'bg-border text-text-muted';
    return `index inline-flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full text-[11px] font-bold ${state}`;
  });

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
