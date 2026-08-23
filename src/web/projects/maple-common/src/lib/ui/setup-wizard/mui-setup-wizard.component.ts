// MuiSetupWizard — Maple UI Organisms, Wave W6 Lane B "Configuration"
// (docs/unified-component-catalog.md §4.8). Multi-step guided
// configuration, built from ProgressStep, Button, plus caller-projected
// step bodies (see MuiWizardStepDirective).
//
// The step sequence indicator is a stack of ProgressStep rows (index/label/
// status, one per step) rather than Tabs — Tabs implies freely jumping
// between panels, which doesn't fit a linear wizard where later steps are
// gated on earlier ones being valid. ProgressStep's own "Continue" button
// (shown only on the active step) is wired to the same gated `attemptAdvance`
// path as the footer's Next/Finish button, so it can't bypass `canGoNext` —
// the footer button is still the one with a real `disabled` binding, since
// ProgressStep's button has no disabled input of its own.

import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChildren,
  input,
  model,
  output,
} from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import type { MuiProgressStepStatus } from '../progress-step/mui-progress-step.component';
import { MuiProgressStepComponent } from '../progress-step/mui-progress-step.component';
import { MuiWizardStepDirective } from './mui-wizard-step.directive';

@Component({
  selector: 'mui-setup-wizard',
  standalone: true,
  imports: [MuiButtonComponent, MuiProgressStepComponent, NgTemplateOutlet],
  templateUrl: './mui-setup-wizard.component.html',
  styleUrl: './mui-setup-wizard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSetupWizardComponent {
  readonly steps = input.required<readonly string[]>();
  readonly stepIndex = model<number>(0);
  /** Whether the current step's content is valid enough to move on. Gates
   * the footer's Next/Finish button. */
  readonly canGoNext = input<boolean>(true);

  readonly stepChanged = output<number>();
  readonly finished = output<void>();

  private readonly stepTemplates = contentChildren(MuiWizardStepDirective, {
    descendants: false,
  });

  readonly activeTemplate = computed(
    () => this.stepTemplates()[this.stepIndex()]?.templateRef ?? null,
  );

  readonly isLastStep = computed(() => this.stepIndex() === this.steps().length - 1);

  readonly nextLabel = computed(() => (this.isLastStep() ? 'Finish' : 'Next'));

  statusFor(index: number): MuiProgressStepStatus {
    const current = this.stepIndex();
    return index < current ? 'done' : index === current ? 'active' : 'pending';
  }

  goBack(): void {
    const current = this.stepIndex();
    if (current === 0) return;
    const previous = current - 1;
    this.stepIndex.set(previous);
    this.stepChanged.emit(previous);
  }

  attemptAdvance(): void {
    if (!this.canGoNext()) return;
    if (this.isLastStep()) {
      this.finished.emit();
      return;
    }
    const next = this.stepIndex() + 1;
    this.stepIndex.set(next);
    this.stepChanged.emit(next);
  }
}
