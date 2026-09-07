// GeometrySection.swift — manual-geometry tool surface (#3410).
//
// Replaces the group's living-slider stack while the Geometry tool is armed,
// the same swap-in-a-custom-surface pattern `LensCorrectionsSection` (#2231),
// `FilmSection` (#2683) and `HSLSection` (#274) use, and for the same
// structural reason: seven sliders with no single primary field, so
// `Tool.geometry.displayRange` stays nil and this IS the whole control
// surface.
//
//   ┌────────────────────────────────────────────────┐
//   │  Vertical      ──────────●───────────      0    │  ← keystone pair
//   │  Horizontal    ──────────●───────────      0    │
//   ├────────────────────────────────────────────────┤
//   │  Rotate        ──────────●───────────    0.0    │  ← ±10°, finer than
//   │  Scale         ────────────●─────────    100    │     Crop's straighten
//   │  Aspect        ──────────●───────────      0    │
//   ├────────────────────────────────────────────────┤
//   │  X Offset      ──────────●───────────      0    │  ← reframe after a
//   │  Y Offset      ──────────●───────────      0    │     correction
//   └────────────────────────────────────────────────┘
//
// All seven compose into ONE homography in the shared core
// (`raw_core::stages::perspective`), applied between EXIF orientation and the
// user crop on the CPU export tail and in the WGSL present shader alike — so
// dragging a slider reframes the live canvas exactly as the exported master
// will be framed. They are display-tail parameters, not decode-product ones,
// so unlike the lens scales they preview per tick rather than committing on
// release.
//
// Reset and undo come free from the shared sub-param pipe: a double-click on
// a track resets that slider (`LivingSlider`'s `defaultValue`), and
// `onEditingChanged` opens exactly one transaction per gesture.
//
// The guided line-drawing mode (draw two or four lines, solve the keystone)
// ships on web only; Apple and Windows expose the sliders.

import MapleCore
import MapleUI
import SwiftUI

struct GeometrySection: View {
  @Bindable var state: EditorState

  private var session: EditSession { state.session }

  /// The seven sub-params in declaration order, read once off the tool so the
  /// labels, ranges and defaults cannot drift from the canonical schema.
  private static let subs = Tool.geometry.subParams

  /// Sliders whose default sits at the centre of their range draw the centre
  /// notch; `scale` (50…150, default 100) does not, because its default is
  /// the *identity*, not a midpoint the user reads as neutral-either-way.
  private static let bipolarIds: Set<String> = [
    "vertical", "horizontal", "rotate", "aspect", "offsetX", "offsetY",
  ]

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Self.subs, id: \.id) { sub in
        slider(sub)
          .accessibilityIdentifier("slider-geometry-\(sub.id)")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-geometry-section")
  }

  private func slider(_ sub: ToolSubParam) -> some View {
    LivingSlider(
      label: sub.label,
      value: Binding(
        get: { session.model[keyPath: sub.keyPath] },
        set: { newValue in
          if state.armedTool != .geometry { state.arm(tool: .geometry) }
          if state.armedSubParamId != sub.id {
            state.arm(subParamId: sub.id)
          }
          state.setArmedDisplayValue(newValue)
        }
      ),
      range: sub.range,
      isBipolar: Self.bipolarIds.contains(sub.id),
      defaultValue: sub.defaultDisplayValue,
      onEditingChanged: { editing in
        if editing { state.commit() } else { state.endGesture() }
      }
    )
  }
}

// MARK: - Preview

#if DEBUG
  #Preview("GeometrySection") {
    let state = EditorState(session: EditSession.preview())
    return GeometrySection(state: state)
      .frame(width: 320)
      .padding()
      .background(ProTokens.bg)
  }
#endif
