import { ChangeDetectionStrategy, Component } from '@angular/core';

// Organism specimens (modals, editing surfaces, map, communication,
// configuration) ported verbatim from the Unified Component Catalog canvas
// (Canvas.dc.html, claude.ai/design project 288a7180).
@Component({
  selector: 'app-tier-organisms-modals',
  templateUrl: './tier-organisms-modals.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierOrganismsModalsComponent {}
