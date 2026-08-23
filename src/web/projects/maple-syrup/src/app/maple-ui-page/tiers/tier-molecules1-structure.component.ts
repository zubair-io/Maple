import { ChangeDetectionStrategy, Component } from '@angular/core';

// Molecules L1 (overlays, structure, plots, media) specimens ported
// verbatim from the Unified Component Catalog canvas (Canvas.dc.html,
// claude.ai/design project 288a7180).
@Component({
  selector: 'app-tier-molecules1-structure',
  templateUrl: './tier-molecules1-structure.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierMolecules1StructureComponent {}
