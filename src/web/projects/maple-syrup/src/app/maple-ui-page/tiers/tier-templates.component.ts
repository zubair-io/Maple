import { ChangeDetectionStrategy, Component } from '@angular/core';

// Template-tier region diagrams ported verbatim from the Unified Component
// Catalog canvas (Canvas.dc.html, claude.ai/design project 288a7180).
@Component({
  selector: 'app-tier-templates',
  templateUrl: './tier-templates.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierTemplatesComponent {}
