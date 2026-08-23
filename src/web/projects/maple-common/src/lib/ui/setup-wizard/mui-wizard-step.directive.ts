// MuiWizardStepDirective — companion to MuiSetupWizardComponent. Marks an
// `<ng-template>` as one step's projected body:
//
//   <mui-setup-wizard [steps]="labels" [(stepIndex)]="index">
//     <ng-template muiWizardStep>...step 0 content...</ng-template>
//     <ng-template muiWizardStep>...step 1 content...</ng-template>
//   </mui-setup-wizard>
//
// The wizard reads its `TemplateRef` via a `contentChildren` signal query
// and renders the one at the current `stepIndex` with `NgTemplateOutlet` —
// real content projection for an arbitrary, caller-defined number of steps,
// not a fixed set of hardcoded slots.

import { Directive, TemplateRef, inject } from '@angular/core';

@Directive({
  selector: 'ng-template[muiWizardStep]',
  standalone: true,
})
export class MuiWizardStepDirective {
  // fallow-ignore-next-line unused-class-member -- read via `contentChildren(MuiWizardStepDirective)` results in mui-setup-wizard.component.ts (`this.stepTemplates()[this.stepIndex()]?.templateRef`); fallow's member-usage scan doesn't follow property access on signal-query result elements.
  readonly templateRef = inject(TemplateRef);
}
