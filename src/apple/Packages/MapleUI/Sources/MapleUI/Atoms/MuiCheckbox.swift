// MuiCheckbox.swift — Maple UI Checkbox atom.
// Contract: docs/design/maple-ui/components/checkbox.md

import SwiftUI

public enum MuiCheckboxState: Sendable {
    case unchecked, checked, indeterminate
}

/// A binary or tri-state selection control for lists of independent options
/// (checkbox.md §Purpose) — distinct from a Toggle, which is a single
/// immediate-effect on/off setting.
///
/// SwiftUI's native `.checkbox` `ToggleStyle` only exists on macOS, with no
/// three-state equivalent — this uses the same Button-based custom-control
/// idiom as `MuiButton`/`MuiActionButton` (traits + an explicit
/// `accessibilityValue` standing in for the native indeterminate/mixed-state
/// API) rather than a styled `<div>` with a click handler and no role.
public struct MuiCheckbox: View {
    public let state: MuiCheckboxState
    public let label: String
    public let disabled: Bool
    public let action: () -> Void

    @FocusState private var isFocused: Bool

    public init(
        state: MuiCheckboxState,
        label: String,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) {
        self.state = state
        self.label = label
        self.disabled = disabled
        self.action = action
    }

    public var body: some View {
        Button {
            guard !disabled else { return }
            action()
        } label: {
            HStack(spacing: MuiTokens.spacingXs) {
                box
                Text(label)
                    .font(MuiTokens.TypeScale.font(.body))
                    .foregroundStyle(MuiTokens.textMain)
            }
            .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .focused($isFocused)
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
        .accessibilityLabel(label)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(Self.accessibilityValue(for: state))
    }

    private var box: some View {
        RoundedRectangle(cornerRadius: MuiTokens.radiusXs, style: .continuous)
            .fill(state == .unchecked ? Color.clear : MuiTokens.primary)
            .overlay(
                RoundedRectangle(cornerRadius: MuiTokens.radiusXs, style: .continuous)
                    .stroke(state == .unchecked ? MuiTokens.border : Color.clear, lineWidth: 1.5)
            )
            .overlay(glyph)
            .overlay(
                RoundedRectangle(cornerRadius: MuiTokens.radiusXs, style: .continuous)
                    .stroke(isFocused ? MuiTokens.primary.opacity(0.2) : .clear, lineWidth: 2)
                    .padding(-2)
            )
            .frame(width: 18, height: 18)
    }

    @ViewBuilder
    private var glyph: some View {
        switch state {
        case .unchecked:
            EmptyView()
        case .checked:
            Image(systemName: "checkmark")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(MuiTokens.textMain)
        case .indeterminate:
            Image(systemName: "minus")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(MuiTokens.textMain)
        }
    }

    /// The accessible value distinguishing all three states (checkbox.md
    /// §Accessibility: indeterminate must be announced distinctly, not
    /// merely rendered differently). Public + static for unit testing
    /// without rendering a view.
    public static func accessibilityValue(for state: MuiCheckboxState) -> String {
        switch state {
        case .unchecked: return "Unchecked"
        case .checked: return "Checked"
        case .indeterminate: return "Mixed"
        }
    }
}

#Preview("MuiCheckbox — States") {
    VStack(alignment: .leading, spacing: 12) {
        MuiCheckbox(state: .unchecked, label: "Unchecked") {}
        MuiCheckbox(state: .checked, label: "Checked") {}
        MuiCheckbox(state: .indeterminate, label: "Some selected") {}
        MuiCheckbox(state: .checked, label: "Disabled", disabled: true) {}
    }
    .padding()
    .background(MuiTokens.bg)
}
