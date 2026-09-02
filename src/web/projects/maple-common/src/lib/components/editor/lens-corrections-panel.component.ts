// LensCorrectionsPanelComponent — DNG lens-correction toggle + sliders
// (#2231, follow-up to #376's model + XMP fields).
//
// Projected into `pro-control-card`'s `cardBodyLens` slot (same shape as
// `pro-color-grading-panel`'s `cardBodyGrade` / `FilmPanelComponent`'s
// `cardBodyFilm`) whenever the Lens Corrections tool is armed. Master
// toggle (`lensProfileEnable`) plus three sliders (distortion / chromatic
// aberration / vignetting) — Apple's `LensCorrectionsSection.swift` is the
// structural twin.
//
// All three sliders are DECODE-PRODUCT fields: moving any of them re-runs
// the Rust decode (`OpcodeList3` application), not a per-tick render — the
// same class of field as `deepDenoise`/`chromaPrefilter` on the Noise
// pill (spec § 3.1/§ 3.2, "the UI commits on release, not per tick"). This
// component does NOT go through `EditorStateService`'s armed-pair deferred-
// write machinery (that machinery is keyed to the drag-bar/wheel/sub-param-
// row surface a bespoke panel like this one bypasses, the same way
// `FilmPanelComponent`'s strength slider writes straight to
// `LibraryStateService`) — instead each slider tracks its OWN in-progress
// value locally between `dragStart`/`dragEnd` and writes to the model only
// once, on release.
//
// #3182 (split out of #2231): mirrors Apple's `LensCorrectionsSection` gate
// — the whole panel (toggle + all three sliders) disables + dims when the
// open RAW carries no `OpcodeList3` (`LibraryStateService.lensCorrectionsFor`,
// seeded at cold-open time from `hasLensCorrections`/`lensCorrectionCaInert`);
// the CA slider ADDITIONALLY disables + dims on its own when the DNG's
// `WarpRectilinear` opcode carries only a single (not per-plane) coefficient
// set — but only in that narrower case, not also when the whole panel is
// already off, so the two dims don't multiply (same reasoning as Apple's
// `.opacity` gate on the CA slider specifically checking
// `hasLensCorrections && lensCorrectionCaInert`, not just `lensCorrectionCaInert`).

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { MuiLivingSliderComponent } from '../../ui/living-slider/mui-living-slider.component';
import { ADJUSTMENT_RANGES, type AdjustmentModel } from '../../models/adjustment-model';
import { DEFAULT_LENS_CORRECTION_CAPABILITY } from '../../state/library-store-lens-corrections';

const DISTORTION_RANGE = ADJUSTMENT_RANGES.lensCorrectionDistortion;
const CA_RANGE = ADJUSTMENT_RANGES.lensCorrectionCa;
const VIGNETTING_RANGE = ADJUSTMENT_RANGES.lensCorrectionVignetting;

@Component({
  selector: 'lens-corrections-panel',
  standalone: true,
  imports: [MuiLivingSliderComponent],
  templateUrl: './lens-corrections-panel.component.html',
  host: { class: 'block min-h-0' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LensCorrectionsPanelComponent {
  private readonly library = inject(LibraryStateService);
  private readonly editorState = inject(EditorStateService);

  readonly distortionMin = DISTORTION_RANGE[0];
  readonly distortionMax = DISTORTION_RANGE[1];
  readonly caMin = CA_RANGE[0];
  readonly caMax = CA_RANGE[1];
  readonly vignettingMin = VIGNETTING_RANGE[0];
  readonly vignettingMax = VIGNETTING_RANGE[1];

  private readonly adj = computed<AdjustmentModel | null>(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)() : null;
  });

  readonly enabled = computed<boolean>(() => this.adj()?.lensProfileEnable === 'On');

  /** Decode-time lens-correction signal for the focused asset (#3182) — the
   *  fail-closed default (panel disabled) when nothing has decoded yet. */
  private readonly capabilities = computed(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.lensCorrectionsFor(id) : DEFAULT_LENS_CORRECTION_CAPABILITY;
  });
  /** Whole panel: toggle + all three sliders. */
  readonly panelDisabled = computed<boolean>(() => !this.capabilities().hasLensCorrections);
  /** True only when the panel IS active but the CA scale is a structural
   *  no-op — the narrower case the dim class gates on (see file banner). */
  readonly caInertOnly = computed<boolean>(
    () => this.capabilities().hasLensCorrections && this.capabilities().lensCorrectionCaInert,
  );
  readonly caDisabled = computed<boolean>(() => this.panelDisabled() || this.caInertOnly());

  // In-progress drag values — `null` when no gesture is live, in which
  // case the slider tracks the committed model value. See the file banner
  // for why these hold the value locally instead of writing per tick.
  private readonly liveDistortion = signal<number | null>(null);
  private readonly liveCa = signal<number | null>(null);
  private readonly liveVignetting = signal<number | null>(null);

  readonly distortion = computed<number>(
    () => this.liveDistortion() ?? this.adj()?.lensCorrectionDistortion ?? this.distortionMax,
  );
  readonly ca = computed<number>(() => this.liveCa() ?? this.adj()?.lensCorrectionCa ?? this.caMax);
  readonly vignetting = computed<number>(
    () => this.liveVignetting() ?? this.adj()?.lensCorrectionVignetting ?? this.vignettingMax,
  );

  toggleEnabled(): void {
    if (this.panelDisabled()) return; // #3182 — defense-in-depth past the `disabled` attribute
    const id = this.library.focusedAssetId();
    if (!id) return;
    this.editorState.commit();
    this.library.updateAdjustment(id, { lensProfileEnable: this.enabled() ? 'Off' : 'On' });
  }

  onDistortionChange(v: number): void {
    this.liveDistortion.set(v);
  }
  onDistortionDragEnd(): void {
    this.commit('lensCorrectionDistortion', this.liveDistortion);
  }
  onDistortionReset(): void {
    this.liveDistortion.set(null);
    this.writeNow('lensCorrectionDistortion', this.distortionMax);
  }

  onCaChange(v: number): void {
    this.liveCa.set(v);
  }
  onCaDragEnd(): void {
    this.commit('lensCorrectionCa', this.liveCa);
  }
  onCaReset(): void {
    this.liveCa.set(null);
    this.writeNow('lensCorrectionCa', this.caMax);
  }

  onVignettingChange(v: number): void {
    this.liveVignetting.set(v);
  }
  onVignettingDragEnd(): void {
    this.commit('lensCorrectionVignetting', this.liveVignetting);
  }
  onVignettingReset(): void {
    this.liveVignetting.set(null);
    this.writeNow('lensCorrectionVignetting', this.vignettingMax);
  }

  /** Write the field's parked live value once (drag end) and clear the
   *  local override so the slider goes back to tracking the model. */
  private commit(
    field: 'lensCorrectionDistortion' | 'lensCorrectionCa' | 'lensCorrectionVignetting',
    live: ReturnType<typeof signal<number | null>>,
  ): void {
    const v = live();
    live.set(null);
    if (v === null) return;
    this.writeNow(field, v);
  }

  private writeNow(
    field: 'lensCorrectionDistortion' | 'lensCorrectionCa' | 'lensCorrectionVignetting',
    v: number,
  ): void {
    const id = this.library.focusedAssetId();
    if (!id) return;
    // Snapshot undo BEFORE the write (Copilot review on #3184) — same
    // "commit, then write" ordering `EditorStateService`'s own mutators use,
    // so a Lens Corrections gesture is undoable like every other edit.
    this.editorState.commit();
    this.library.updateAdjustment(id, { [field]: v });
  }
}
