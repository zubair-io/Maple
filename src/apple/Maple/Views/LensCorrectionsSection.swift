// LensCorrectionsSection.swift — Lens Corrections tool surface (#2231).
//
// The "Profile" row (#3567, bundled-Lensfun epic #3564 slice 3) adds a
// dropdown above the three strength sliders: Automatic first (showing the
// resolver's matched lens or "no match"), every bundled lens the RAW's body
// can carry, and the imported LCP reference (#3395) when the sidecar
// already names one. `LensProfileChoice` (MapleCore) owns the async raw-ffi
// round trip and the pure evidence→state mapping; this view only renders
// its published state and forwards a pick to `select(_:)`. Per-family
// coverage from that resolved evidence — not the old embedded-only
// `EditSession.hasLensCorrections`/`lensCorrection*Inert` signal — now
// drives which strength row is enabled, since a Lensfun match can correct a
// RAW that carries no embedded `OpcodeList3` at all.
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
//   │  Profile   [ Automatic — Sony FE 24-70mm ▾ ]    │  ← the dropdown (#3567)
//   │  Lensfun database 12f5976 (2026-09-11) · CC…    │  ← source line
//   │  Distortion    ──────────●───────────    100    │
//   │  Chromatic Aberration  ────●──────────    100    │  ← greyed when the
//   │  Vignetting    ──────────●───────────    100    │     resolved calibration
//   └────────────────────────────────────────────────┘     has no data for it
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
// Two disabled states, independent of each other, both now driven by
// `LensProfileChoice`'s resolved evidence rather than the old embedded-only
// `EditSession.hasLensCorrections`/`lensCorrection*Inert` trio (#3567): a
// Lensfun match can correct a RAW that carries no embedded `OpcodeList3` at
// all, so the old embedded-only signal under-reported availability once
// the bundled database (#3564) shipped.
//   * The WHOLE section greys out (dropdown, toggle, and every slider) when
//     `LensProfileChoice.isAvailable == false` — the resolved evidence for
//     the current selection has no coverage in any family AND the dropdown
//     has no pickable lens beyond Automatic, so there is nothing for any
//     control here to do.
//   * Each strength row ALONE greys out when the resolved evidence's
//     `hasDistortion`/`hasCa`/`hasVignetting` is false for that family —
//     e.g. a vignette-only DNG (`FixVignetteRadial` with no
//     `WarpRectilinear`) still leaves Distortion inert even though
//     Vignetting works, and a `WarpRectilinear` opcode with a single
//     coefficient set (no per-plane divergence) leaves CA inert. A
//     hand-edited sidecar value stays visibly greyed rather than hidden, so
//     the user can see it round-trips even though it does nothing here.

import MapleCore
import MapleUI
import SwiftUI

struct LensCorrectionsSection: View {
  @Bindable var state: EditorState

  /// Created/reloaded by the `.task(id:)` pair on `profileRow` — one keyed
  /// on the session identity (a new asset means a brand-new resolver
  /// target), one on `model.lensProfile` (a pick, an undo/redo, or a preset
  /// apply all need a fresh resolve). `nil` only until the first task body
  /// runs.
  @State private var lensProfileChoice: LensProfileChoice?

  private var session: EditSession { state.session }

  private static let distortionSub = Tool.lensCorrections.subParams[0]
  private static let caSub = Tool.lensCorrections.subParams[1]
  private static let vignettingSub = Tool.lensCorrections.subParams[2]

  /// Disabled-state opacity — matches `MuiToggle.opacity(disabled:)` so
  /// the toggle and the sliders it gates read as one visual system.
  private static let disabledOpacity = 0.45

  /// Profile-free lateral CA (#3411). A DECODE-PRODUCT toggle like the
  /// three scales above — flipping it re-runs the Rust decode — so it
  /// commits through `state.commit()` exactly the way the master switch
  /// does. Enabled only when the RAW's own opcodes carry no CA data
  /// (`lensCorrectionCaInert`): where they do, the vendor's coefficients
  /// are authoritative and the raw-domain stage self-skips, so offering
  /// the switch would promise a correction that can never run.
  private var autoLateralCaBinding: Binding<Bool> {
    Binding(
      get: { session.model.autoLateralCa == .on },
      set: { newValue in
        state.commit()
        session.model.autoLateralCa = newValue ? .on : .off
      }
    )
  }

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
    VStack(alignment: .leading, spacing: 14) {
      profileGroup
      // Profile-free lateral CA (#3411) — deliberately OUTSIDE the group
      // above, and outside its `hasLensCorrections` gate: this correction
      // exists precisely for the bodies that ship no lens data at all, so
      // greying it out with the profile block would hide it on every RAW
      // it is meant for.
      MuiToggle(
        checked: autoLateralCaBinding,
        label: "Remove Chromatic Aberration",
        disabled: !session.lensCorrectionCaInert
      )
      .accessibilityIdentifier("editor-auto-lateral-ca-toggle")
      .accessibilityHint(
        session.lensCorrectionCaInert
          ? "Estimates and removes lateral chromatic aberration from the image itself"
          : "This RAW's lens profile already corrects chromatic aberration"
      )
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-lens-corrections-section")
  }

  private var profileGroup: some View {
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

  /// `true` once resolved evidence says there's something for the master
  /// toggle to turn on — either the current selection has real coverage, or
  /// the dropdown offers a pickable lens beyond Automatic. `false` (and
  /// therefore fully greyed, matching the old default) until the first
  /// `LensProfileChoice.reload()` completes.
  private var isAvailable: Bool { lensProfileChoice?.isAvailable ?? false }

  private var controls: some View {
    VStack(alignment: .leading, spacing: 10) {
      MuiToggle(
        checked: enabledBinding,
        label: "Lens Profile Corrections",
        disabled: !isAvailable
      )
      .accessibilityIdentifier("editor-lens-corrections-toggle")

      profileRow

      slider(Self.distortionSub)
        .disabled(!(lensProfileChoice?.coverage.hasDistortion ?? false))
        // Same opacity-multiplication reasoning as the CA slider below:
        // only gate the distortion-alone-missing case here.
        .opacity(
          (isAvailable && !(lensProfileChoice?.coverage.hasDistortion ?? false))
            ? Self.disabledOpacity : 1
        )
        .accessibilityIdentifier("slider-lens-distortion")
        .accessibilityHint(
          (isAvailable && !(lensProfileChoice?.coverage.hasDistortion ?? false))
            ? "This lens profile carries no distortion data"
            : ""
        )
      slider(Self.caSub)
        .disabled(!(lensProfileChoice?.coverage.hasCa ?? false))
        // Opacity gates ONLY the CA-alone-missing case: the whole-section
        // disabled case is already covered by the VStack's own
        // `.opacity` below, and SwiftUI opacities MULTIPLY down the
        // view tree — repeating that same condition here would double
        // it to 0.45×0.45 ≈ 0.2, visibly darker than its siblings
        // (Jules review).
        .opacity(
          (isAvailable && !(lensProfileChoice?.coverage.hasCa ?? false)) ? Self.disabledOpacity : 1
        )
        .accessibilityIdentifier("slider-lens-ca")
        .accessibilityHint(
          (isAvailable && !(lensProfileChoice?.coverage.hasCa ?? false))
            ? "This lens profile carries no chromatic-aberration data"
            : ""
        )
      slider(Self.vignettingSub)
        .disabled(!(lensProfileChoice?.coverage.hasVignetting ?? false))
        .opacity(
          (isAvailable && !(lensProfileChoice?.coverage.hasVignetting ?? false))
            ? Self.disabledOpacity : 1
        )
        .accessibilityIdentifier("slider-lens-vignetting")
        .accessibilityHint(
          (isAvailable && !(lensProfileChoice?.coverage.hasVignetting ?? false))
            ? "This lens profile carries no vignetting data"
            : ""
        )
    }
    .disabled(!isAvailable)
    .opacity(isAvailable ? 1 : Self.disabledOpacity)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-lens-profile-group")
  }

  /// The "Profile" dropdown + source line (#3567). Bound directly to
  /// `model.lensProfile` — every option's `value` IS the exact string that
  /// field holds (`""` for Automatic, `lensfun1:…`, or the sidecar's
  /// existing `lcp1(-ack):…`) — so the picker's selection and the model are
  /// never out of sync. A pick routes through `LensProfileChoice.select(_:)`
  /// rather than writing the model directly, so the undoable-edit and
  /// master-toggle-untouched contracts live in one place, unit-tested
  /// without a view host.
  @ViewBuilder
  private var profileRow: some View {
    let vm = lensProfileChoice
    let options = (vm?.options ?? []).map { MuiSelectOption(value: $0.modelValue, label: $0.label) }
    VStack(alignment: .leading, spacing: 4) {
      MuiSelect(
        value: Binding(
          get: { session.model.lensProfile },
          set: { newValue in
            guard let option = vm?.options.first(where: { $0.modelValue == newValue }) else { return }
            vm?.select(option)
          }
        ),
        options: options.isEmpty ? [MuiSelectOption(value: "", label: "Automatic")] : options,
        accessibilityLabel: "Lens profile",
        disabled: vm == nil || vm?.isLoading == true
      )
      .accessibilityIdentifier("editor-lens-profile-select")

      Text(vm?.sourceDescription ?? "")
        .font(MapleTokens.Typography.body)
        .foregroundStyle(MapleTokens.textMuted)
        .accessibilityIdentifier("editor-lens-profile-source")
    }
    .task(id: session.asset.id) {
      let newVM = LensProfileChoice(session: session)
      lensProfileChoice = newVM
      await newVM.reload()
    }
    .task(id: session.model.lensProfile) {
      await lensProfileChoice?.reload()
    }
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
        if editing {
          state.beginSliderInteraction(tool: .lensCorrections, subParamID: sub.id)
        } else {
          state.endGesture()
        }
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
