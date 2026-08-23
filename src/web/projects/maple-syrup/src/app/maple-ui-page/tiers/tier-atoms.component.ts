import { ChangeDetectionStrategy, Component } from '@angular/core';

// Atom-tier specimens ported verbatim from the Unified Component Catalog
// canvas (Canvas.dc.html, claude.ai/design project 288a7180).
@Component({
  selector: 'app-tier-atoms',
  templateUrl: './tier-atoms.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierAtomsComponent {}
