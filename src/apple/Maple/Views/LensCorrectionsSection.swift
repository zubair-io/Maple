// LensCorrectionsSection.swift — Lens Corrections tool surface (#2231).
//
// Replaces the group's living-slider stack while the Lens tool is armed,
// the same swap-in-a-custom-surface pattern `FilmSection` (#2683) and
// `HSLSection` (#274) use, for the same structural reason: the panel needs
// a master on/off toggle ABOVE its sliders — a shape the generic
// sub-param grid has no room for — so this IS the tool's whole control
// surface (`displayRange` stays nil, matching Tone Curve / HSL / Film).
//
//   ┌────────────────────────────────────────────────┐
//   │  Lens Profile Corrections            [ ⏻ ]      │  ← master toggle,
//   ├────────────────────────────────────────────────┤     `lensProfileEnable`
//   │  Distortion    ──────────●───────────    100    │
//   │  Chromatic Aberration  ────●──────────    100    │  ← greyed when the
//   │  Vignetting    ──────────●───────────    100    │     DNG's warp has no
//   └────────────────────────────────────────────────┘     per-plane CA data
//
// `lens_profile_enable` / `lens_correction_{distortion,ca,vignetting}`
// round-trip through the Rust, Swift, and TypeScript sidecar layers since
// #376; this ticket is the first user-facing control for them. All three
// scales are DECODE-PRODUCT fields — moving any of them re-runs the Rust
// decode, not a per-tick shader pass (spec: "the UI commits on release,
// not per tick", same as `papp:DeepDenoise` / `papp:ChromaPrefilter`) — so
// each is declared with `commitsOnRelease: true` on `Tool.lensCorrections`
// and rides the ordinary sub-param arm/write/undo pipe every other slider
// does; this view supplies only the layout + the master toggle + the two
// disabled states below.
//
// Two disabled states, independent of each other:
//   * The WHOLE section greys out (and every slider becomes inert) when
//     `session.hasLensCorrections == false` — the open RAW carries no
//     `OpcodeList3` at all, so there is nothing for any scale to apply to
//     (#2231's decode-layer signal, threaded from `RawImage::
//     has_lens_corrections` through `EditSession.hasLensCorrections`).
//   * The CA slider ALONE greys out when `session.lensCorrectionCaInert
//     == true` — the DNG's `WarpRectilinear` opcode carries a single
//     coefficient set (no per-plane divergence encoded), so the CA scale
//     is a structural no-op even though distortion/vignetting still work.
//     A hand-edited sidecar value stays visibly greyed rather than hidden,
//     so the user can see it round-trips even though it does nothing here.
//   * The Distortion slider ALONE greys out when
//     `session.lensCorrectionDistortionInert == true` (#3189) — the DNG
//     carries no `WarpRectilinear` opcode at all (e.g. a vignette-only RAW
//     whose only opcode is `FixVignetteRadial`), so there is nothing for
//     the distortion scale to warp even though `hasLensCorrections` is
//     still `true` (a vignette IS a lens correction). Same
//     greys-not-hides treatment as CA.

import MapleCore
import MapleUI
import SwiftUI

struct LensCorrectionsSection: View {
  @Bindable var state: EditorState

  private var session: EditSession { state.session }

  private static let distortionSub = Tool.lensCorrections.subParams[0]
  private static let caSub = Tool.lensCorrections.subParams[1]
  private static let vignettingSub = Tool.lensCorrections.subParams[2]

  /// Disabled-state opacity — matches `MuiToggle.opacity(disabled:)` so
  /// the toggle and the sliders it gates read as one visual system.
  private static let disabledOpacity = 0.45

  private var enabledBinding: Binding<Bool> {
    Binding(
      get: { session.model.lensProfileEnable == .on },
      set: { newValue in
        state.commit()
        session.model.lensProfileEnable = newValue ? .on : .off
      }
    )
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      let support: LensSupport =
        session.hasLensCorrections ? .embeddedCorrection : .noCorrectionData
      Text(support.label).font(MapleTokens.Typography.body)
      Text(support.explanation).font(MapleTokens.Typography.body)
        .foregroundStyle(MapleTokens.textMuted)
        .accessibilityIdentifier("editor-lens-support")
      controls
    }
  }

  private var controls: some View {
    VStack(alignment: .leading, spacing: 10) {
      MuiToggle(
        checked: enabledBinding,
        label: "Lens Profile Corrections",
        disabled: !session.hasLensCorrections
      )
      .accessibilityIdentifier("editor-lens-corrections-toggle")

      slider(Self.distortionSub)
        .disabled(!session.hasLensCorrections || session.lensCorrectionDistortionInert)
        // Same opacity-multiplication reasoning as the CA slider below:
        // only gate the distortion-alone-inert case here.
        .opacity(
          (session.hasLensCorrections && session.lensCorrectionDistortionInert)
            ? Self.disabledOpacity : 1
        )
        .accessibilityIdentifier("slider-lens-distortion")
        .accessibilityHint(
          (session.hasLensCorrections && session.lensCorrectionDistortionInert)
            ? "This RAW's lens profile carries no distortion data"
            : ""
        )
      slider(Self.caSub)
        .disabled(!session.hasLensCorrections || session.lensCorrectionCaInert)
        // Opacity gates ONLY the CA-alone-inert case: the whole-section
        // disabled case is already covered by the VStack's own
        // `.opacity` below, and SwiftUI opacities MULTIPLY down the
        // view tree — repeating that same condition here would double
        // it to 0.45×0.45 ≈ 0.2, visibly darker than its siblings
        // (Jules review).
        .opacity(
          (session.hasLensCorrections && session.lensCorrectionCaInert) ? Self.disabledOpacity : 1
        )
        .accessibilityIdentifier("slider-lens-ca")
        .accessibilityHint(
          (session.hasLensCorrections && session.lensCorrectionCaInert)
            ? "This RAW's lens profile carries no chromatic-aberration data"
            : ""
        )
      slider(Self.vignettingSub)
        .accessibilityIdentifier("slider-lens-vignetting")
    }
    .disabled(!session.hasLensCorrections)
    .opacity(session.hasLensCorrections ? 1 : Self.disabledOpacity)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-lens-corrections-section")
  }

  private func slider(_ sub: ToolSubParam) -> some View {
    LivingSlider(
      label: sub.label,
      value: Binding(
        get: { session.model[keyPath: sub.keyPath] },
        set: { newValue in
          if state.armedTool != .lensCorrections { state.arm(tool: .lensCorrections) }
          if state.armedSubParamId != sub.id {
            state.arm(subParamId: sub.id)
          }
          state.setArmedDisplayValue(newValue)
        }
      ),
      range: sub.range,
      isBipolar: false,
      defaultValue: sub.defaultDisplayValue,
      onEditingChanged: { editing in
        if editing { state.commit() } else { state.endGesture() }
      }
    )
  }
}

// MARK: - Preview

#if DEBUG
  #Preview("LensCorrectionsSection") {
    let state = EditorState(session: EditSession.preview())
    return LensCorrectionsSection(state: state)
      .frame(width: 320)
      .padding()
      .background(ProTokens.bg)
  }
#endif
