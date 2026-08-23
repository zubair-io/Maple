import { ChangeDetectionStrategy, Component } from '@angular/core';

// Page-tier composition diagrams ported verbatim from the Unified
// Component Catalog canvas (Canvas.dc.html, claude.ai/design project
// 288a7180).
@Component({
  selector: 'app-tier-pages',
  templateUrl: './tier-pages.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierPagesComponent {}
