// MuiToggle.swift — Maple UI Toggle atom.
// Contract: docs/design/maple-ui/components/toggle.md

import SwiftUI

/// A single immediate-effect on/off switch — e.g. "enable auto-save" (toggle.md
/// §Purpose) — distinct from `MuiCheckbox`, which selects among independent
/// options in a list with no standalone effect until a separate commit action.
///
/// Wraps SwiftUI's native `Toggle` in the platform switch style rather than a
/// custom-drawn track (toggle.md §Accessibility: state changes must reach
/// assistive technology through the native switch role — HTML/ARIA `switch`,
/// SwiftUI's default switch style, WinUI `ToggleSwitch` — not a styled view
/// with a tap handler bolted on). `.tint` recolors the native switch's "on"
/// track to `color.primary` per toggle.md §States; the thumb and "off" track
/// colors are the platform's own, since `.switch` doesn't expose separate
/// thumb/track color hooks the way a custom control would.
public struct MuiToggle: View {
    @Binding public var checked: Bool
    public let label: String
    public let disabled: Bool

    public init(checked: Binding<Bool>, label: String, disabled: Bool = false) {
        self._checked = checked
        self.label = label
        self.disabled = disabled
    }

    public var body: some View {
        Toggle(isOn: $checked) {
            Text(label)
                .font(MuiTokens.TypeScale.font(.body))
                .foregroundStyle(MuiTokens.textMain)
        }
        .toggleStyle(.switch)
        .tint(MuiTokens.primary)
        .disabled(disabled)
        .opacity(Self.opacity(disabled: disabled))
        .frame(minHeight: 44)
        .accessibilityLabel(label)
    }

    /// Disabled-state opacity (toggle.md §States: 40-50%, matching every
    /// other MapleUI atom). Public + static, mirroring `MuiCheckbox`'s
    /// `accessibilityValue(for:)` and `MuiBadge`'s `accessibleLabel(...)` —
    /// the one piece of `MuiToggle` with real branching logic, pulled out so
    /// it's unit-testable without rendering a `Toggle` through a host.
    public static func opacity(disabled: Bool) -> Double {
        disabled ? 0.45 : 1
    }
}

#Preview("MuiToggle — States") {
    struct Demo: View {
        @State private var off = false
        @State private var on = true
        @State private var disabledOff = false
        @State private var disabledOn = true

        var body: some View {
            VStack(alignment: .leading, spacing: 12) {
                MuiToggle(checked: $off, label: "Off")
                MuiToggle(checked: $on, label: "On")
                MuiToggle(checked: $disabledOff, label: "Disabled, off", disabled: true)
                MuiToggle(checked: $disabledOn, label: "Disabled, on", disabled: true)
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
