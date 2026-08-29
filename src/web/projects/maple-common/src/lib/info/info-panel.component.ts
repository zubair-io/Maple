// InfoPanelComponent — Responsive-program S6 Info content (web side).
//
// Spec: docs/design/responsive-program/s6-info-inspector.md.
// Tracking ticket: #621 (closed by PR #637). #634 follow-up consolidates
// the former `<maple-info-tab>` enrichment surface into this panel. The
// application now owns that optional extension at its composition root.
// Maple UI migration (#3030, MW3): rating/flag, histogram, EXIF/GPS grid,
// and keyword chips now render through mui-ui molecules (`mui-rating-flags`,
// `mui-histogram`, `mui-label-value-grid`, `mui-keyword-row`) instead of
// bespoke `app-*-row` components — see `info-panel.vm.ts` for the Asset→mui
// projections and the deletion note at the bottom of this file.
//
// The filename row stays on `<app-info-filename-row>` / the shared
// `InlineRenameFieldComponent` (deliberately NOT migrated onto
// `mui-inline-rename-field` — see that decision recorded in the MW3 PR
// description): that field is also driven by `library-cell`'s F2 shortcut
// through the same `AssetRenameCapability`, coordinating a single "one
// editor open at a time" state (disabled-reason tooltips, busy/error,
// same-name collision resolution) across two independent widgets. Folding
// that coordination into the mui molecule was judged out of MW3's
// behavior-preserving scope.
//
// One component, two slots:
//   • Phone bottom sheet (`<mui-sheet-shell>`) triggered by the `i` icon
//     in the Editor (S5) header. `[insideSheet]="true"` renders an inline
//     sheet header (title + close X) because the bottom sheet primitive
//     ships only a grab handle.
//   • Tablet / desktop right inspector pane. `[insideSheet]="false"`
//     drops the sheet header because the parent panel's tab bar already
//     labels the panel "Info".
//
// Sections (rendered top-to-bottom):
//   1. <app-info-filename-row>     — double-click-to-rename, shared field.
//   2. <mui-rating-flags>          — pick/unflag/reject pills + 5 stars.
//   3. <mui-histogram>             — live-canvas pixels, server fallback.
//   4. <mui-label-value-grid>      — 2-col EXIF / GPS key-value grid.
//   5. <mui-keyword-row>           — editable chips (add / remove).
//   6. App-provided extension      — Self Hosted supplies enrichment from its
//                                    composition root; Hosted supplies none.

import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { catchError, of } from 'rxjs';
import type { Asset } from '../models/asset';
import type { ApiHistogram } from '../api/bun-api-backend.service';
import { ImageCanvasService } from '../components/image-canvas/image-canvas.service';
import { computeRgbHistograms } from '../raw-pipeline/image-utils';
import { SERVER_LIBRARY_IO } from '../workspace/server-library-io';
import { LibraryStateService } from '../state/library-state.service';
import { InfoFilenameRowComponent } from './info-filename-row.component';
import { INFO_PANEL_EXTENSION } from './info-panel-extension';
import {
  cameraLocationRows,
  fromMuiFlagState,
  keywordChips,
  toHistogramBins,
  toMuiFlagState,
} from './info-panel.vm';
import { MuiButtonComponent } from '../ui/button/mui-button.component';
import { MuiHistogramComponent } from '../ui/histogram/mui-histogram.component';
import { MuiKeywordRowComponent } from '../ui/keyword-row/mui-keyword-row.component';
import { MuiLabelValueGridComponent } from '../ui/label-value-grid/mui-label-value-grid.component';
import { MuiRatingFlagsComponent } from '../ui/rating-flags/mui-rating-flags.component';
import type { MuiRatingFlagState } from '../ui/rating-flags/mui-rating-flags.component';

@Component({
  selector: 'app-info-panel',
  standalone: true,
  imports: [
    InfoFilenameRowComponent,
    MuiButtonComponent,
    MuiRatingFlagsComponent,
    MuiHistogramComponent,
    MuiLabelValueGridComponent,
    MuiKeywordRowComponent,
    NgComponentOutlet,
  ],
  templateUrl: './info-panel.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-testid': 'info-panel',
    class: 'block bg-sidebar overflow-auto',
    '[class]': 'paddingClass()',
  },
})
export class InfoPanelComponent {
  protected readonly extension = inject(INFO_PANEL_EXTENSION);

  /** Mutually-exclusive padding pair (Tailwind port #3071) —
   * `:host(.inside-sheet)` used to override the base `:host`'s
   * `padding: 16px` shorthand on just the bottom side; expanded into two
   * full, non-overlapping per-side class sets (rather than a shorthand
   * `p-4` plus a conditional `pb-8` add-on) per the port's host-class
   * rule, so precedence never depends on Tailwind's utility registration
   * order. `inside-sheet` kept bare for any external `::ng-deep` styling. */
  protected paddingClass(): string {
    return this.insideSheet() ? 'inside-sheet pt-4 pr-4 pb-8 pl-4' : 'pt-4 pr-4 pb-4 pl-4';
  }
  private readonly state = inject(LibraryStateService);
  private readonly serverIo = inject(SERVER_LIBRARY_IO, { optional: true });
  private readonly canvas = inject(ImageCanvasService);

  /** Focused asset whose info to render. `null` keeps the layout stable
   * (each section degrades to placeholder values) so the panel doesn't
   * jump between empty and populated states. */
  readonly asset = input<Asset | null>(null);

  /** `true` on the phone bottom-sheet slot — renders the in-content
   * header (title + close X). `false` on the tablet/desktop inspector
   * pane, where the parent tab bar already says "Info". */
  readonly insideSheet = input<boolean>(false);

  /** Permit a server histogram when this surface has no live canvas pixels.
   * Editor callers disable this; Browse/Preview retain the default fallback. */
  readonly allowServerHistogramFallback = input<boolean>(true);

  /** Phone-only dismiss signal for the sheet's close X. Ignored when
   * `insideSheet=false`. */
  readonly close = output<void>();

  onClose(): void {
    this.close.emit();
  }

  // ── Rating / flag — mui-rating-flags wiring ──────────────────────────
  // LibraryStateService.setFlag/setRating already handles the asset-row
  // write + SidecarStore debounced flush (parity with the keyboard
  // handlers in EditorShell — keys 1-5/P/X/U hit the same service
  // methods), so the two-way `[(rating)]`/`[(flag)]` models below commit
  // straight through — no local draft state to reconcile.

  protected readonly ratingFlagsDisabled = computed(() => this.asset() === null);
  protected readonly currentRating = computed(() => this.asset()?.rating ?? 0);
  protected readonly currentFlagState = computed(() =>
    toMuiFlagState(this.asset()?.flag ?? 'unflagged'),
  );

  protected onRatingChange(rating: number): void {
    const a = this.asset();
    if (!a || a.rating === rating) return;
    this.state.setRating(a.id, rating);
  }

  protected onFlagChange(state: MuiRatingFlagState): void {
    const a = this.asset();
    const flag = fromMuiFlagState(state);
    if (!a || a.flag === flag) return;
    this.state.setFlag(a.id, flag);
  }

  // ── EXIF / GPS grid — mui-label-value-grid wiring ────────────────────

  protected readonly metadataRows = computed(() => cameraLocationRows(this.asset()));

  // ── Keywords — mui-keyword-row wiring ────────────────────────────────

  protected readonly keywords = computed(() => keywordChips(this.asset()));

  protected onKeywordAdded(keyword: string): void {
    const a = this.asset();
    if (!a) return;
    this.state.setKeywords(a.id, [...(a.keywords ?? []), keyword]);
  }

  protected onKeywordRemoved(keyword: string): void {
    const a = this.asset();
    if (!a) return;
    this.state.setKeywords(
      a.id,
      (a.keywords ?? []).filter((k) => k !== keyword),
    );
  }

  // ── Histogram — mui-histogram wiring ─────────────────────────────────
  //
  // Source priority (unchanged from the retired InfoHistogramComponent):
  //   1. Live local pixels — the editor canvas publishes a decoded
  //      snapshot to `ImageCanvasService.currentPixels`, binned on device
  //      so the histogram works for local (non-server) files and updates
  //      with every edit.
  //   2. The server-computed histogram (Browse mode, or before the canvas
  //      has decoded).
  //   3. `null`, which hides `<mui-histogram>` entirely — mui-histogram
  //      has no decorative-placeholder mode of its own, so this panel
  //      just omits the element rather than the old SVG's dashed-line
  //      placeholder.

  /** Stable request identity. Asset records are enriched by replacement
   * while Preview is open; depending on the full object would cancel and
   * restart the same expensive native histogram request. */
  private readonly assetId = computed(() => this.asset()?.id ?? null);

  /** Server-computed histogram (fallback), or null when not yet loaded /
   *  failed / no asset. The live local path below takes precedence. */
  private readonly serverHistogram = signal<ApiHistogram | null>(null);

  protected readonly histogramBins = computed(() => {
    // Only source from live local pixels when an asset is actually bound —
    // the canvas service may still hold a previous image's snapshot, and
    // the contract is: no asset ⇒ no histogram.
    const px = this.asset() ? this.canvas.currentPixels() : null;
    if (px) {
      const { r, g, b } = computeRgbHistograms(px);
      return { r: toHistogramBins(r), g: toHistogramBins(g), b: toHistogramBins(b) };
    }
    const h = this.serverHistogram();
    if (!h) return null;
    return { r: h.r, g: h.g, b: h.b };
  });

  constructor() {
    // Refetch only when the logical asset ID changes. Preview enriches its
    // Asset record by object replacement, which must not restart this
    // native request for the same file.
    effect((onCleanup) => {
      const assetId = this.assetId();
      const allowServerFallback = this.allowServerHistogramFallback();
      this.serverHistogram.set(null);
      if (!allowServerFallback || !assetId || !this.serverIo) return;
      const sub = this.serverIo
        .getHistogram(assetId)
        .pipe(
          catchError(() => {
            // Network / 4xx / 5xx — fall back to `null` (no histogram).
            // The 503 path (dylib unavailable on the server) lands here.
            return of(null);
          }),
        )
        .subscribe((h) => {
          this.serverHistogram.set(h);
        });
      onCleanup(() => sub.unsubscribe());
    });
  }
}
