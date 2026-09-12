// MuiSelect.swift — Maple UI Select atom.
// Contract: docs/design/maple-ui/components/select.md

import SwiftUI

/// One choice in a `MuiSelect` — a stable `value` (what gets written back
/// through the binding) paired with the `label` shown in the closed field
/// and the open option list.
public struct MuiSelectOption: Identifiable, Equatable, Sendable {
    public let value: String
    public let label: String

    public var id: String { value }

    public init(value: String, label: String) {
        self.value = value
        self.label = label
    }
}

/// A single-choice dropdown for a small, fixed option set (select.md
/// §Purpose) — settings pages, sort orders, unit pickers. Distinct from
/// Command Menu (a searchable molecule for large option sets).
///
/// Wraps SwiftUI's native `Picker` in the `.menu` style rather than a
/// custom-drawn popover, so the platform's own combobox/menu role carries
/// the state to assistive technology and the control is keyboard-operable
/// end to end for free (select.md §Accessibility) — the same reasoning
/// `MuiToggle` documents for wrapping the native switch. Field chrome
/// (`color.input_bg` fill, `color.border` outline, `radius.md`) matches
/// `MuiInput`'s closed state, per select.md §States.
public struct MuiSelect: View {
    @Binding public var value: String
    public let options: [MuiSelectOption]
    public let accessibilityLabel: String
    public let disabled: Bool

    public init(
        value: Binding<String>,
        options: [MuiSelectOption],
        accessibilityLabel: String,
        disabled: Bool = false
    ) {
        self._value = value
        self.options = options
        self.accessibilityLabel = accessibilityLabel
        self.disabled = disabled
    }

    public var body: some View {
        // ViewBuilder-label form (not `Picker(_ titleKey:selection:content:)`)
        // because `accessibilityLabel` is a runtime `String`, not a string
        // literal — SwiftUI's title-key initializer needs a
        // `LocalizedStringKey`, which only bridges from a literal. Matches
        // `MuiToggle`'s `Toggle(isOn:) { Text(label) }` for the same reason.
        Picker(selection: $value) {
            ForEach(options) { option in
                Text(option.label).tag(option.value)
            }
        } label: {
            Text(accessibilityLabel)
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .font(MuiTokens.TypeScale.font(.body))
        .foregroundStyle(MuiTokens.textMain)
        .padding(.horizontal, MuiTokens.spacingMd)
        .padding(.vertical, MuiTokens.spacingSm)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .background(MuiTokens.inputBg, in: RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous)
                .stroke(MuiTokens.border, lineWidth: 1)
        )
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(options.first(where: { $0.value == value })?.label ?? value)
    }
}

#Preview("MuiSelect — States") {
    struct Demo: View {
        @State private var sort = "date"
        @State private var locked = "auto"

        private let sortOptions = [
            MuiSelectOption(value: "date", label: "Date"),
            MuiSelectOption(value: "name", label: "Name"),
            MuiSelectOption(value: "rating", label: "Rating"),
        ]
        private let lockedOptions = [
            MuiSelectOption(value: "auto", label: "Automatic")
        ]

        var body: some View {
            VStack(alignment: .leading, spacing: 12) {
                MuiSelect(value: $sort, options: sortOptions, accessibilityLabel: "Sort order")
                MuiSelect(value: $locked, options: lockedOptions, accessibilityLabel: "Locked select", disabled: true)
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
