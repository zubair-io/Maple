import { ChangeDetectionStrategy, Component } from '@angular/core';

// Molecules L1 (form, selection, feedback) specimens ported verbatim from
// the Unified Component Catalog canvas (Canvas.dc.html, claude.ai/design
// project 288a7180).
@Component({
  selector: 'app-tier-molecules1-form',
  templateUrl: './tier-molecules1-form.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierMolecules1FormComponent {}
