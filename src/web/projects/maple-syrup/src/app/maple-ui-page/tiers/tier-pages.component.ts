import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  MuiPageAdminComponent,
  MuiPageBoardComponent,
  MuiPageBrowseComponent,
  MuiPageChatComponent,
  MuiPageDocumentComponent,
  MuiPageEditorComponent,
  MuiPageNotificationsComponent,
  MuiPagePairingComponent,
  MuiPagePreviewComponent,
  MuiPageSearchComponent,
  MuiPageSettingsComponent,
  MuiPageSignInComponent,
  MuiPageTvMapComponent,
  MuiPageTvTimelineComponent,
  MuiPageTvViewerComponent,
} from '@maple-common';

// Page-tier specimens — Wave W7 (#3000). Every card now renders the real
// `mui-page-*` composition — a Template hosting several Wave 1-6 organisms
// with real, wired mock data — inside a fixed 480×300 chip, instead of the
// static composition-diagram markup this tier shipped with (ported verbatim
// from the Unified Component Catalog canvas), matching every other
// converted tier's "no drift from the shipped implementation" rationale.
//
// A Page renders at its natural desktop size (1440×900 — the inner
// `.page-canvas` box) and is then visually scaled down to fit the chip via
// a CSS `transform: scale(...)`. This keeps every Split Layout's
// `ResizeObserver`-driven collapse logic seeing its real (desktop) width —
// a CSS transform doesn't change an element's layout box, only how it's
// painted — so each Page renders in its normal 3-column/multi-region
// layout rather than its narrow-viewport collapsed form.
@Component({
  selector: 'app-tier-pages',
  imports: [
    MuiPageAdminComponent,
    MuiPageBoardComponent,
    MuiPageBrowseComponent,
    MuiPageChatComponent,
    MuiPageDocumentComponent,
    MuiPageEditorComponent,
    MuiPageNotificationsComponent,
    MuiPagePairingComponent,
    MuiPagePreviewComponent,
    MuiPageSearchComponent,
    MuiPageSettingsComponent,
    MuiPageSignInComponent,
    MuiPageTvMapComponent,
    MuiPageTvTimelineComponent,
    MuiPageTvViewerComponent,
  ],
  templateUrl: './tier-pages.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierPagesComponent {}
