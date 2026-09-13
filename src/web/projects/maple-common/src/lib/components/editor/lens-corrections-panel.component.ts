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
//
// #3479: an imported LCP profile (`LensProfileImportComponent`, mounted at
// the top of this panel) is the other way the panel comes alive. Once the
// sidecar names a profile and a render has reported the resolver's verdict
// for it (`lensCorrectionsFor(id).lensProfile`, refreshed by every render
// reply), the panel enables even without an `OpcodeList3`, and each
// strength slider disables individually for a family the calibration does
// not cover — a strength for an uncalibrated family is inert in raw-core.
// Embedded corrections still win: a RAW with its own opcodes reports the
// profile as `embedded`, and the opcode gates above apply unchanged.
//
// #3569: a bundled Lensfun match (automatic, or a manual `lensfun1:` pick
// from `LensProfileSelectComponent`'s dropdown) is a THIRD way the panel
// comes alive — the develop path already applies it with no `OpcodeList3`
// and no imported LCP, so leaving the toggle/sliders looking inert while
// that's happening would visibly contradict what the render is doing.
// `profileSelect` reads the dropdown's own resolved evidence (a `viewChild`
// signal query, since that state lives in the child, not here) the same way
// `imported` above reads the render-fed capability signal for an LCP match.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { MuiLivingSliderComponent } from '../../ui/living-slider/mui-living-slider.component';
import { MuiTextComponent } from '../../ui/text/mui-text.component';
import { ADJUSTMENT_RANGES, type AdjustmentModel } from '../../models/adjustment-model';
import { DEFAULT_LENS_CORRECTION_CAPABILITY } from '../../state/library-store-lens-corrections';
import { LensProfileImportComponent } from './lens-profile-import.component';
import { LensProfileSelectComponent } from './lens-profile-select.component';

const DISTORTION_RANGE = ADJUSTMENT_RANGES.lensCorrectionDistortion;
const CA_RANGE = ADJUSTMENT_RANGES.lensCorrectionCa;
const VIGNETTING_RANGE = ADJUSTMENT_RANGES.lensCorrectionVignetting;

@Component({
  selector: 'lens-corrections-panel',
  standalone: true,
  imports: [
    MuiLivingSliderComponent,
    MuiTextComponent,
    LensProfileSelectComponent,
    LensProfileImportComponent,
  ],
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
  readonly lensSupport = computed(() => this.capabilities().cameraSupport);
  /** The renderer's verdict for the imported profile the sidecar currently
   *  names (#3479) — only an `lcp` resolution for THIS selection counts; an
   *  `embedded` verdict means the RAW's own opcodes won and gate as before. */
  readonly imported = computed(() => {
    const profile = this.capabilities().lensProfile;
    return profile?.source === 'lcp' && profile.reference === this.adj()?.lensProfile
      ? profile
      : undefined;
  });
  /** The profile dropdown, once it renders (#3569) — `undefined` only for
   *  the render tick before the child view exists. */
  private readonly profileSelect = viewChild(LensProfileSelectComponent);
  /** The dropdown's resolved evidence for the reference currently in effect,
   *  when it's a bundled Lensfun match — `imported`'s counterpart for the
   *  OTHER external source a RAW can carry no `OpcodeList3` for. */
  readonly bundledMatch = computed(() => {
    const evidence = this.profileSelect()?.evidence();
    return evidence?.source === 'lensfun' ? evidence : undefined;
  });
  /** Whether the dropdown has anything to pick beyond Automatic — mirrors
   *  Apple's `isAvailable` counting a pickable-but-not-yet-picked lens as
   *  "something for the toggle to turn on", not only a resolved match. */
  private readonly hasBundledOption = computed(
    () => (this.profileSelect()?.compatibleLenses().length ?? 0) > 0,
  );
  /** Whole panel: toggle + all three sliders. */
  readonly panelDisabled = computed<boolean>(
    () =>
      !this.capabilities().hasLensCorrections &&
      !this.imported() &&
      !this.bundledMatch() &&
      !this.hasBundledOption(),
  );
  /**
   * Per-family coverage from whichever resolved source currently applies,
   * in the same precedence the develop path itself uses: a bundled Lensfun
   * match, else an imported LCP, else the embedded opcode (assumed to cover
   * distortion + vignetting; CA per its own `lensCorrectionCaInert` flag),
   * else no coverage at all — which happens when the panel is "available"
   * only because the dropdown has something pickable (#3569's
   * `hasBundledOption`) but nothing has actually resolved yet, e.g. right
   * after opening an asset the bundle doesn't auto-match. Unifying the three
   * strengths through one source of truth is what keeps that last case from
   * silently falling back to "enabled" the way three separate ad-hoc
   * `imported ? … : …` ternaries did before this ticket.
   */
  private readonly resolvedCoverage = computed<{
    hasDistortion: boolean;
    hasCa: boolean;
    hasVignetting: boolean;
  }>(() => {
    const bundled = this.bundledMatch();
    if (bundled) {
      return {
        hasDistortion: bundled.hasDistortion,
        hasCa: bundled.hasCa,
        hasVignetting: bundled.hasVignetting,
      };
    }
    const imported = this.imported();
    if (imported) {
      return {
        hasDistortion: imported.hasDistortion ?? false,
        hasCa: imported.hasCa ?? false,
        hasVignetting: imported.hasVignetting ?? false,
      };
    }
    const caps = this.capabilities();
    return caps.hasLensCorrections
      ? { hasDistortion: true, hasCa: !caps.lensCorrectionCaInert, hasVignetting: true }
      : { hasDistortion: false, hasCa: false, hasVignetting: false };
  });
  readonly distortionDisabled = computed<boolean>(
    () => this.panelDisabled() || !this.resolvedCoverage().hasDistortion,
  );
  readonly vignettingDisabled = computed<boolean>(
    () => this.panelDisabled() || !this.resolvedCoverage().hasVignetting,
  );
  /** True only when the panel IS active but the CA scale is a structural
   *  no-op — the narrower case the dim class gates on (see file banner);
   *  `!panelDisabled()` is what keeps this from ALSO firing (and
   *  double-dimming) while the whole-panel opacity already covers it. */
  readonly caInertOnly = computed<boolean>(
    () => !this.panelDisabled() && !this.resolvedCoverage().hasCa,
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

  /** Profile-free lateral CA (#3411). Enabled ONLY when the RAW's own
   *  opcodes carry no CA data: where they do, the vendor's coefficients are
   *  authoritative and the raw-domain stage self-skips, so offering the
   *  switch would promise a correction that can never run. Deliberately NOT
   *  gated on `panelDisabled()` — this correction exists for the bodies
   *  that ship no `OpcodeList3` at all. */
  readonly autoLateralCa = computed<boolean>(() => this.adj()?.autoLateralCa === 'On');
  readonly autoLateralCaDisabled = computed<boolean>(
    () => !this.capabilities().lensCorrectionCaInert,
  );

  toggleAutoLateralCa(): void {
    if (this.autoLateralCaDisabled()) return;
    const id = this.library.focusedAssetId();
    if (!id) return;
    this.editorState.commit();
    this.library.updateAdjustment(id, { autoLateralCa: this.autoLateralCa() ? 'Off' : 'On' });
  }

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
