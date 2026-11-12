// WhiteBalancePad.swift — temperature × tint pad for the canvas-first
// editor (#5121), the Apple twin of web's `wb-pad.component.ts`.
//
// Temperature runs left to right (cool to warm) and tint bottom to top
// (green to magenta). A press anywhere moves the puck there, so a fingertip,
// an Apple Pencil and a pointer all place it directly; a hovering Pencil or
// pointer previews the pair a press would set. One drag, or one held arrow
// key, is one Undo step, and the pair is written through the same path the
// Temperature and Tint sliders use.

import MapleCore
import MapleUI
import SwiftUI

struct WhiteBalancePad: View {
  let state: EditorState
  @Environment(\.mapleLayout) private var layout
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @State private var hover: MuiPad2DValue?

  /// The temperature and tint slider tracks, crossed: one source for the
  /// colours a value is drawn in, wherever it is edited.
  private static let fill = MuiPad2DFill.axes(
    horizontal: Gradient(
      stops: GradientCatalog.temp.map { Gradient.Stop(color: color($0), location: $0.t) }),
    vertical: Gradient(stops: [
      Gradient.Stop(color: tintEdge(1, opacity: 0.4), location: 0),
      Gradient.Stop(color: tintEdge(1, opacity: 0), location: 0.5),
      Gradient.Stop(color: tintEdge(0, opacity: 0), location: 0.5),
      Gradient.Stop(color: tintEdge(0, opacity: 0.35), location: 1),
    ]))

  private static func color(_ stop: GradientStop) -> Color {
    Color(red: stop.r, green: stop.g, blue: stop.b)
  }

  /// The tint track's colour at its green (`0`) or magenta (`1`) end.
  private static func tintEdge(_ t: Double, opacity: Double) -> Color {
    let stop = GradientCatalog.tint.min { abs($0.t - t) < abs($1.t - t) }
    return (stop.map(color) ?? .clear).opacity(opacity)
  }

  private var model: AdjustmentModel { state.session.model }

  private var isDisabled: Bool {
    state.session.showingOriginal || state.autoInProgress || state.whiteBalancePicker.isSampling
  }

  private var padValue: Binding<MuiPad2DValue> {
    Binding(
      get: {
        MuiPad2DValue(
          x: WhiteBalancePadMath.fraction(forTemperature: model.temperature) * 2 - 1,
          y: WhiteBalancePadMath.fraction(forTint: model.tint) * 2 - 1)
      },
      set: { value in
        let pair = Self.pair(at: value)
        write(
          WhiteBalancePadMath.applying(
            temperature: pair.temperature, tint: pair.tint, to: model))
      })
  }

  /// A landscape iPhone has room for little above its ruler.
  private var isShort: Bool { layout == .phone && verticalSizeClass == .compact }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      readout
      sizedPad
      if !isShort {
        HStack {
          Text(Self.kelvin(AdjustmentModel.temperatureRange.lowerBound))
          Spacer(minLength: 0)
          Text(Self.kelvin(AdjustmentModel.temperatureRange.upperBound))
        }
        .font(.system(size: 9))
        .foregroundStyle(ProTokens.textDim)
        .accessibilityHidden(true)
      }
    }
    .frame(maxWidth: .infinity)
  }

  /// The compact bar keeps a fixed, short pad so the ruler stays in view;
  /// the inspector holds the 2:1 shape the web pad uses.
  @ViewBuilder private var sizedPad: some View {
    if layout == .phone {
      pad.frame(height: isShort ? 64 : 96).accessibilityIdentifier("editor-wb-pad")
    } else {
      pad.aspectRatio(2, contentMode: .fit).accessibilityIdentifier("editor-wb-pad")
    }
  }

  var pad: MuiPad2D {
    MuiPad2D(
      value: padValue, size: nil, fill: Self.fill, crosshair: true,
      accessibilityLabel: "White balance pad",
      valueText: "Temperature \(Self.kelvin(model.temperature)), tint \(Self.signed(model.tint))",
      disabled: isDisabled,
      onEditingChanged: { editing in
        if editing {
          state.whiteBalancePicker.cancel()
          state.commit(description: "White Balance")
        } else {
          state.endGesture()
        }
      },
      onStep: { direction in
        switch direction {
        case .left: write(WhiteBalancePadMath.stepping(model, temperatureSteps: -1))
        case .right: write(WhiteBalancePadMath.stepping(model, temperatureSteps: 1))
        case .up: write(WhiteBalancePadMath.stepping(model, tintSteps: 1))
        case .down: write(WhiteBalancePadMath.stepping(model, tintSteps: -1))
        }
      },
      onHover: { hover = $0 })
  }

  private var readout: some View {
    HStack(spacing: 6) {
      Text(Self.kelvin(model.temperature))
        .font(MapleTokens.Typography.valueChip).monospacedDigit()
        .foregroundStyle(ProTokens.text)
      Text(Self.signed(model.tint))
        .font(MapleTokens.Typography.valueChip).monospacedDigit()
        .foregroundStyle(ProTokens.textMuted)
      Spacer(minLength: 4)
      if let hover {
        let pair = Self.pair(at: hover)
        Text("\(Self.kelvin(pair.temperature))  \(Self.signed(pair.tint))")
          .font(MapleTokens.Typography.valueChip).monospacedDigit()
          .foregroundStyle(ProTokens.textDim)
          .accessibilityIdentifier("editor-wb-pad-hover")
      }
    }
    .lineLimit(1)
    .accessibilityHidden(true)
  }

  private func write(_ next: AdjustmentModel) {
    guard next != state.session.model else { return }
    state.session.model = next
  }

  /// The pair a pad position stands for; the pad's axes run `[-1, 1]`.
  static func pair(at value: MuiPad2DValue) -> (temperature: Double, tint: Double) {
    (
      WhiteBalancePadMath.temperature(atFraction: (value.x + 1) / 2),
      WhiteBalancePadMath.tint(atFraction: (value.y + 1) / 2)
    )
  }

  private static func kelvin(_ temperature: Double) -> String {
    let clamped = min(
      max(temperature, AdjustmentModel.temperatureRange.lowerBound),
      AdjustmentModel.temperatureRange.upperBound)
    return String(format: "%.0f K", clamped)
  }

  private static func signed(_ tint: Double) -> String {
    let clamped = min(
      max(tint, AdjustmentModel.tintRange.lowerBound), AdjustmentModel.tintRange.upperBound)
    let rounded = (clamped * 10).rounded() / 10
    let text = rounded == rounded.rounded() ? String(format: "%.0f", rounded) : String(rounded)
    return rounded >= 0 ? "+\(text)" : text
  }
}
