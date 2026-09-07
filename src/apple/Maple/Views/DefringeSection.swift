// DefringeSection.swift — Defringe tool surface (#3411).
//
// The per-tick half of the profile-free lens corrections. Where
// `LensCorrectionsSection` scales what a DNG already encodes, this panel
// suppresses the colour fringe a lens leaves behind on a high-contrast
// edge — the purple or green halo that survives (or that lateral-CA
// correction never addressed, because it is longitudinal, not geometric).
//
//   ┌────────────────────────────────────────────────┐
//   │  Purple                                        │
//   │  Amount        ●───────────────────      0     │
//   │  Hue Low       ──────●────────────       30    │
//   │  Hue High      ────────────●──────       70    │
//   │  Green                                         │
//   │  Amount        ●───────────────────      0     │
//   │  Hue Low       ─────────●─────────       40    │
//   │  Hue High      ───────────●───────       60    │
//   └────────────────────────────────────────────────┘
//
// Six sub-params and no single "main" one, so `Tool.defringe` keeps
// `displayRange == nil` and this view is its whole control surface — the
// shape HSL / Tone Curve / Film / Lens Corrections already use. Unlike
// Lens Corrections, none of these commits on release: the stage runs in
// the per-tick scene-linear chain (between dehaze and local adjustments,
// with a WGSL mirror), so every drag is a live re-render, not a re-decode.
//
// The two amounts are ACR's own `crs:Defringe{Purple,Green}Amount` (0..20)
// and the hue edges its `[0, 100]` defringe-hue axis, so a sidecar
// authored in Lightroom lands on the same bands here.

import MapleCore
import MapleUI
import SwiftUI

struct DefringeSection: View {
  @Bindable var state: EditorState

  private var session: EditSession { state.session }

  private static let subs = Tool.defringe.subParams

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Purple")
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("editor-defringe-purple-heading")
      slider(Self.subs[0], identifier: "slider-defringe-purple-amount")
      slider(Self.subs[1], identifier: "slider-defringe-purple-hue-lo")
      slider(Self.subs[2], identifier: "slider-defringe-purple-hue-hi")

      Text("Green")
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("editor-defringe-green-heading")
      slider(Self.subs[3], identifier: "slider-defringe-green-amount")
      slider(Self.subs[4], identifier: "slider-defringe-green-hue-lo")
      slider(Self.subs[5], identifier: "slider-defringe-green-hue-hi")
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-defringe-section")
  }

  private func slider(_ sub: ToolSubParam, identifier: String) -> some View {
    LivingSlider(
      label: sub.label,
      value: Binding(
        get: { session.model[keyPath: sub.keyPath] },
        set: { newValue in
          if state.armedTool != .defringe { state.arm(tool: .defringe) }
          if state.armedSubParamId != sub.id { state.arm(subParamId: sub.id) }
          state.setArmedDisplayValue(newValue)
        }
      ),
      range: sub.range,
      isBipolar: false,
      defaultValue: sub.defaultDisplayValue,
      onEditingChanged: { editing in
        if editing {
          state.beginSliderInteraction(tool: .defringe, subParamID: sub.id)
        } else {
          state.endGesture()
        }
      }
    )
    .accessibilityIdentifier(identifier)
  }
}

// MARK: - Preview

#if DEBUG
  #Preview("DefringeSection") {
    let state = EditorState(session: EditSession.preview())
    return DefringeSection(state: state)
      .frame(width: 320)
      .padding()
      .background(ProTokens.bg)
  }
#endif
