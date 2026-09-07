// MaskRangeSection.swift — the "Colour range" block of the Mask panel
// (#362): an enable toggle, the eyedropper that seeds the band from a
// tapped canvas colour, the seeded hue, and the five range sliders bound to
// the selected layer's `RangeRefinement`. Sits under the ten adjustment
// sliders in `MaskPanel` on every layout (stacked, flyout, phone).
//
// Slider rows follow `MaskSliderRow`'s contract exactly: a plain `Slider`
// writing straight into `session.model` per sample, bracketed by
// `setMaskDragActive` on `onEditingChanged` — open at drag start, CLOSED at
// drag end, so each drag is exactly one undo entry and nothing that happens
// afterwards is swallowed into it (#3453 review) — and the overlay hidden
// for the drag's duration (#3364).

import MapleCore
import MapleUI
import SwiftUI

struct MaskRangeSection: View {
  @Bindable var state: EditorState
  let layerId: UUID

  private var range: RangeRefinement? { state.session.maskRange(id: layerId) }
  private var picker: MaskRangePicker { state.maskRangePicker }

  var body: some View {
    VStack(spacing: 4) {
      HStack(spacing: 8) {
        MuiToggle(
          checked: Binding(
            get: { range != nil },
            set: { state.session.setMaskRangeEnabled(id: layerId, enabled: $0) }),
          label: "Colour range")
        .accessibilityIdentifier("editor-mask-range-toggle")
        Spacer(minLength: 0)
        if let range {
          Text(String(format: "Hue %.0f°", Self.displayHue(range.hueDeg)))
            .font(.system(size: 11).monospacedDigit())
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("editor-mask-range-hue")
          MuiButton(
            label: picker.isArmed ? "Cancel" : "Sample",
            variant: picker.isArmed ? .primary : .ghost,
            size: .sm,
            leadingIcon: "eyedropper",
            isLoading: picker.isSampling
          ) {
            if picker.isArmed { picker.cancel() } else { picker.arm() }
          }
          .accessibilityLabel(
            picker.isArmed ? "Cancel colour sampling" : "Sample a colour for the range")
          .accessibilityIdentifier("editor-mask-range-eyedropper")
        }
      }
      if let message = picker.message {
        Text(message)
          .font(.caption)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityIdentifier("editor-mask-range-message")
      }
      if range != nil {
        ForEach(RangeField.allCases) { field in
          MaskRangeSliderRow(state: state, layerId: layerId, field: field)
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-mask-range-section")
  }

  /// The wire keeps atan2's `(-180, 180]`; people read a hue on `[0, 360)`.
  static func displayHue(_ hueDeg: Double) -> Double {
    let wrapped = hueDeg.truncatingRemainder(dividingBy: 360)
    return wrapped < 0 ? wrapped + 360 : wrapped
  }
}

private struct MaskRangeSliderRow: View {
  @Bindable var state: EditorState
  let layerId: UUID
  let field: RangeField

  private var value: Double {
    state.session.maskRange(id: layerId)?.value(of: field) ?? 0
  }

  var body: some View {
    HStack {
      Text(field.label).font(.system(size: 11)).frame(width: 90, alignment: .leading)
      Slider(
        value: Binding(
          get: { value },
          set: { state.session.setMaskRangeField(id: layerId, field, $0) }
        ),
        in: field.range,
        onEditingChanged: { editing in state.session.setMaskDragActive(editing) }
      )
      Text(String(format: field == .hueWidth ? "%.0f°" : "%.2f", value))
        .font(.system(size: 11).monospacedDigit())
        .frame(width: 40, alignment: .trailing)
    }
    .accessibilityIdentifier("editor-mask-range-slider-\(field.rawValue)")
  }
}
