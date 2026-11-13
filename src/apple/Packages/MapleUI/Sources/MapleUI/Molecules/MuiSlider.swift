// MuiSlider.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.1). Labeled slider with a numeric readout, built from Text + Input.
// Contract: docs/design/maple-ui/components/slider.md. Wraps SwiftUI's native
// `Slider` (this platform's equivalent of the web reference's native
// `input[type=range]`) so keyboard operation, drag, and screen-reader
// semantics come for free rather than being reimplemented.

import SwiftUI

public enum MuiSliderHelperTone: Sendable, Equatable {
  case muted
  case warning
}

public struct MuiSlider: View {
  public let label: String
  @Binding public var value: Double
  public let range: ClosedRange<Double>
  public let step: Double
  public let unit: String
  public let disabled: Bool
  public let helper: String?
  public let helperTone: MuiSliderHelperTone
  public let onCommit: ((Double) -> Void)?
  public let identifier: String?
  public let helperIdentifier: String?

  @State private var valueAtEditStart: Double?

  public init(
    label: String,
    value: Binding<Double>,
    range: ClosedRange<Double> = 0...100,
    step: Double = 1,
    unit: String = "",
    disabled: Bool = false,
    helper: String? = nil,
    helperTone: MuiSliderHelperTone = .muted,
    onCommit: ((Double) -> Void)? = nil,
    identifier: String? = nil,
    helperIdentifier: String? = nil
  ) {
    self.label = label
    self._value = value
    self.range = range
    self.step = step
    self.unit = unit
    self.disabled = disabled
    self.helper = helper
    self.helperTone = helperTone
    self.onCommit = onCommit
    self.identifier = identifier
    self.helperIdentifier = helperIdentifier
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
      VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
        HStack {
          MuiText(label, variant: .toolLabel, color: .muted)
          Spacer()
          MuiText(readout, variant: .valueChip, color: .main)
        }

        Slider(value: $value, in: range, step: step, onEditingChanged: editingChanged)
          .tint(MuiTokens.primary)
          .frame(minHeight: Self.minimumTapHeight)
          .disabled(disabled)
          .accessibilityLabel(label)
          .accessibilityIdentifier(identifier ?? "")
          .accessibilityValue(
            Self.accessibilityValue(
              value: value, range: range, step: step, unit: unit,
              helper: helper, helperTone: helperTone)
          )
          .accessibilityHint(
            Self.accessibilityHint(helper: helper, helperTone: helperTone) ?? ""
          )
      }
      .opacity(disabled ? Self.disabledOpacity : 1)

      if let helper, !helper.isEmpty {
        helperLine(helper)
      }
    }
    .onChange(of: warningReason, initial: true) { _, reason in
      guard let reason else { return }
      AccessibilityNotification.Announcement(reason).post()
    }
  }

  private var readout: String {
    Self.valueLabel(value: value, range: range, step: step, unit: unit)
  }

  private var warningReason: String? {
    Self.warningReason(helper: helper, helperTone: helperTone)
  }

  /// The reason to announce: a warning helper with text. `onChange(initial:)`
  /// posts it once when the slider appears with a reason already present, and
  /// again only when the reason changes.
  static func warningReason(helper: String?, helperTone: MuiSliderHelperTone) -> String? {
    guard helperTone == .warning, let helper, !helper.isEmpty else { return nil }
    return helper
  }

  @ViewBuilder
  private func helperLine(_ text: String) -> some View {
    switch helperTone {
    case .muted:
      MuiText(text, variant: .body, color: .muted)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier(helperIdentifier ?? "")
    case .warning:
      HStack(alignment: .firstTextBaseline, spacing: MuiTokens.spacingXs) {
        MuiIcon(name: "info", size: .sm, color: MuiTokens.warn)
          .accessibilityHidden(true)
        MuiText(text, variant: .body, color: .warning)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier(helperIdentifier ?? "")
      }
    }
  }

  private func editingChanged(_ editing: Bool) {
    if editing {
      valueAtEditStart = valueAtEditStart ?? value
      return
    }
    let start = valueAtEditStart
    valueAtEditStart = nil
    guard Self.shouldCommit(start: start, end: value) else { return }
    onCommit?(value)
  }

  static let minimumTapHeight: CGFloat = 44
  static let disabledOpacity: Double = 0.45

  /// The unit-suffixed readout shown beside the label (slider.md §Variants).
  /// Unsigned when `range.lowerBound >= 0`; signed with a true minus otherwise.
  /// A `%` unit attaches with no space, any other unit takes one.
  public static func valueLabel(
    value: Double, range: ClosedRange<Double>, step: Double, unit: String
  ) -> String {
    let magnitude = formattedMagnitude(value, step: step)
    let sign = signPrefix(value: value, range: range, step: step, spoken: false)
    let suffix = unit.isEmpty ? "" : (unit == "%" ? "%" : " \(unit)")
    return "\(sign)\(magnitude)\(suffix)"
  }

  /// The readout as it is spoken (slider.md §Accessibility): "50 percent",
  /// "plus 0.3 EV", "minus 0.3 EV".
  public static func spokenValue(
    value: Double, range: ClosedRange<Double>, step: Double, unit: String
  ) -> String {
    let magnitude = formattedMagnitude(value, step: step)
    let sign = signPrefix(value: value, range: range, step: step, spoken: true)
    let spokenUnit = unit == "%" ? "percent" : unit
    let quantity = spokenUnit.isEmpty ? magnitude : "\(magnitude) \(spokenUnit)"
    return sign.isEmpty ? quantity : "\(sign) \(quantity)"
  }

  /// The accessibility value: the spoken value, with a warning reason appended
  /// because a reason is state rather than a hint.
  public static func accessibilityValue(
    value: Double, range: ClosedRange<Double>, step: Double, unit: String,
    helper: String?, helperTone: MuiSliderHelperTone
  ) -> String {
    let spoken = spokenValue(value: value, range: range, step: step, unit: unit)
    guard helperTone == .warning, let helper, !helper.isEmpty else { return spoken }
    return "\(spoken). \(helper)"
  }

  /// A muted helper becomes the accessibility hint.
  public static func accessibilityHint(helper: String?, helperTone: MuiSliderHelperTone) -> String?
  {
    guard helperTone == .muted, let helper, !helper.isEmpty else { return nil }
    return helper
  }

  /// `onCommit` does not fire when the final value equals the value when the
  /// change began (slider.md §Props).
  static func shouldCommit(start: Double?, end: Double) -> Bool {
    guard let start else { return false }
    return start != end
  }

  private static func decimals(step: Double) -> Int {
    step < 0.1 ? 2 : (step < 1 ? 1 : 0)
  }

  private static func formattedMagnitude(_ value: Double, step: Double) -> String {
    String(format: "%.\(decimals(step: step))f", abs(value))
  }

  private static func signPrefix(
    value: Double, range: ClosedRange<Double>, step: Double, spoken: Bool
  ) -> String {
    guard range.lowerBound < 0 else { return "" }
    let scale = pow(10, Double(decimals(step: step)))
    let rounded = (value * scale).rounded() / scale
    if rounded > 0 { return spoken ? "plus" : "+" }
    if rounded < 0 { return spoken ? "minus" : "\u{2212}" }
    return ""
  }
}

#Preview("MuiSlider") {
  struct Demo: View {
    @State private var exposure = 0.3
    @State private var sharpen = 40.0
    @State private var warp = 0.0
    @State private var limited = 100.0

    var body: some View {
      VStack(spacing: 16) {
        MuiSlider(label: "Exposure", value: $exposure, range: -2...2, step: 0.1, unit: "EV")
        MuiSlider(label: "Sharpen", value: $sharpen, range: 0...150, step: 1)
        MuiSlider(
          label: "Boundary Warp", value: $warp, unit: "%",
          helper: "Stretches the edges toward a full rectangle.")
        MuiSlider(
          label: "Boundary Warp", value: $limited, unit: "%",
          helper: "Limited to 62% so the image doesn't fold.", helperTone: .warning)
        MuiSlider(label: "Locked", value: .constant(50), unit: "%", disabled: true)
      }
      .padding()
      .background(MuiTokens.bg)
    }
  }
  return Demo()
}
