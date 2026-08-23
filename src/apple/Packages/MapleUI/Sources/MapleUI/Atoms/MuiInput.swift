// MuiInput.swift — Maple UI Input atom.
// Contract: docs/design/maple-ui/components/input.md

import SwiftUI

public enum MuiInputSize: Sendable {
    case sm, md
}

/// Clamp bounds + increment for the numeric variant's steppers (input.md
/// "Numeric variant with steppers"). Not in the contract's own Props table
/// (which only names the two variants) — this configures the stepper
/// behavior the catalog calls for.
public struct MuiInputNumericConfig: Sendable {
    public let min: Double
    public let max: Double
    public let step: Double

    public init(min: Double = -.infinity, max: Double = .infinity, step: Double = 1) {
        self.min = min
        self.max = max
        self.step = step
    }
}

/// A single-line text field — search boxes, settings fields, filter inputs
/// (input.md §Purpose). `placeholder` is never the sole label (input.md
/// §Accessibility), so `accessibilityLabel` is required, not optional.
public struct MuiInput: View {
    @Binding public var value: String
    public let accessibilityLabel: String
    public let placeholder: String
    public let size: MuiInputSize
    public let prefixIcon: String?
    public let suffixIcon: String?
    public let suffixAction: (() -> Void)?
    public let suffixAccessibilityLabel: String?
    public let showClear: Bool
    public let numeric: MuiInputNumericConfig?
    public let error: String?
    public let disabled: Bool
    public let readOnly: Bool
    public let onCommit: (() -> Void)?

    @FocusState private var isFocused: Bool

    public init(
        value: Binding<String>,
        accessibilityLabel: String,
        placeholder: String = "",
        size: MuiInputSize = .md,
        prefixIcon: String? = nil,
        suffixIcon: String? = nil,
        suffixAction: (() -> Void)? = nil,
        suffixAccessibilityLabel: String? = nil,
        showClear: Bool = false,
        numeric: MuiInputNumericConfig? = nil,
        error: String? = nil,
        disabled: Bool = false,
        readOnly: Bool = false,
        onCommit: (() -> Void)? = nil
    ) {
        self._value = value
        self.accessibilityLabel = accessibilityLabel
        self.placeholder = placeholder
        self.size = size
        self.prefixIcon = prefixIcon
        self.suffixIcon = suffixIcon
        self.suffixAction = suffixAction
        self.suffixAccessibilityLabel = suffixAccessibilityLabel
        self.showClear = showClear
        self.numeric = numeric
        self.error = error
        self.disabled = disabled
        self.readOnly = readOnly
        self.onCommit = onCommit
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: MuiTokens.spacingXs) {
                if let prefixIcon {
                    MuiIcon(name: prefixIcon, size: .sm, color: MuiTokens.textMuted)
                }

                TextField(placeholder, text: $value, onCommit: { onCommit?() })
                    .textFieldStyle(.plain)
                    .font(.system(size: fontSize))
                    .foregroundStyle(MuiTokens.textMain)
                    .focused($isFocused)
                    .disabled(disabled || readOnly)
                    #if os(iOS)
                    .keyboardType(numeric != nil ? .decimalPad : .default)
                    #endif

                if showClear, !value.isEmpty, !disabled, !readOnly {
                    Button {
                        value = ""
                    } label: {
                        MuiIcon(name: "xmark.circle.fill", size: .xs, color: MuiTokens.textMuted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear")
                }

                if let numeric {
                    stepperControls(numeric)
                } else if let suffixIcon {
                    Button {
                        suffixAction?()
                    } label: {
                        MuiIcon(name: suffixIcon, size: .sm, color: MuiTokens.textMuted)
                    }
                    .buttonStyle(.plain)
                    .disabled(disabled || readOnly)
                    .accessibilityLabel(suffixAccessibilityLabel ?? suffixIcon)
                }
            }
            .padding(.horizontal, MuiTokens.spacingMd)
            .padding(.vertical, MuiTokens.spacingSm)
            .frame(minHeight: 44)
            .background(MuiTokens.inputBg, in: RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous)
                    .stroke(borderColor, lineWidth: 1)
            )
            .overlay(
                RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous)
                    .stroke(ringColor, lineWidth: 2)
                    .padding(-2)
            )
            .opacity(disabled ? 0.45 : 1)

            if let error {
                Text(error)
                    .font(MuiTokens.TypeScale.font(.body))
                    .foregroundStyle(MuiTokens.errorText)
                    .accessibilityLabel("Error: \(error)")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(value)
    }

    @ViewBuilder
    private func stepperControls(_ config: MuiInputNumericConfig) -> some View {
        HStack(spacing: 2) {
            Button {
                value = Self.steppedValue(current: value, delta: -config.step, config: config)
            } label: {
                MuiIcon(name: "minus", size: .xs, color: MuiTokens.textMuted)
            }
            .buttonStyle(.plain)
            .disabled(disabled || readOnly)
            .accessibilityLabel("Decrease")

            Button {
                value = Self.steppedValue(current: value, delta: config.step, config: config)
            } label: {
                MuiIcon(name: "plus", size: .xs, color: MuiTokens.textMuted)
            }
            .buttonStyle(.plain)
            .disabled(disabled || readOnly)
            .accessibilityLabel("Increase")
        }
    }

    /// The Error state swaps both the border and the focus ring to the
    /// error color (input.md §States).
    private var borderColor: Color {
        if error != nil { return MuiTokens.errorText }
        if isFocused { return MuiTokens.primary }
        return MuiTokens.border
    }

    private var ringColor: Color {
        guard isFocused else { return .clear }
        return (error != nil ? MuiTokens.errorText : MuiTokens.primary).opacity(0.2)
    }

    private var fontSize: CGFloat {
        size == .sm ? 13 : 14
    }

    /// Applies one stepper tick to a numeric text value, clamping into the
    /// config's `min...max` range. Public + static so clamping is
    /// unit-testable without rendering a view.
    public static func steppedValue(current: String, delta: Double, config: MuiInputNumericConfig) -> String {
        let currentValue = Double(current) ?? 0
        let stepped = Swift.min(config.max, Swift.max(config.min, currentValue + delta))
        return Self.formatNumber(stepped)
    }

    private static func formatNumber(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(value)
    }
}

#Preview("MuiInput — States") {
    struct Demo: View {
        @State private var defaultValue = ""
        @State private var filledValue = "IMG_0042.dng"
        @State private var errorValue = "not-an-email"

        var body: some View {
            VStack(spacing: 12) {
                MuiInput(value: $defaultValue, accessibilityLabel: "Search", placeholder: "Search photos…", prefixIcon: "magnifyingglass", showClear: true)
                MuiInput(value: $filledValue, accessibilityLabel: "Filename")
                MuiInput(value: $errorValue, accessibilityLabel: "Email", error: "Enter a valid email address")
                MuiInput(value: .constant("Locked"), accessibilityLabel: "Locked field", disabled: true)
                MuiInput(value: .constant("Read only"), accessibilityLabel: "Read only field", readOnly: true)
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}

#Preview("MuiInput — Numeric with steppers") {
    struct Demo: View {
        @State private var exposure = "0"

        var body: some View {
            MuiInput(
                value: $exposure,
                accessibilityLabel: "Exposure",
                numeric: MuiInputNumericConfig(min: -5, max: 5, step: 0.5)
            )
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
