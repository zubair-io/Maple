import { ChangeDetectionStrategy, Component } from '@angular/core';

// Organism specimens (collections, navigation, inspectors) ported verbatim
// from the Unified Component Catalog canvas (Canvas.dc.html,
// claude.ai/design project 288a7180).
@Component({
  selector: 'app-tier-organisms-collections',
  templateUrl: './tier-organisms-collections.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierOrganismsCollectionsComponent {}
