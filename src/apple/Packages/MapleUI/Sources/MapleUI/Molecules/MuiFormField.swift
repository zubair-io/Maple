// MuiFormField.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.1). Label + control + help/error, built from Text + Input + Text.

import SwiftUI

/// A labeled single-line field with an optional help caption or error
/// message. `help` and `error` are mutually exclusive on screen — an error
/// takes over the caption line while it's present (form-field pattern
/// shared with the web reference's `mui-form-field`).
public struct MuiFormField: View {
    public let label: String
    @Binding public var value: String
    public let placeholder: String
    public let help: String?
    public let error: String?
    public let required: Bool
    public let disabled: Bool
    public let numeric: MuiInputNumericConfig?
    public let onCommit: (() -> Void)?

    public init(
        label: String,
        value: Binding<String>,
        placeholder: String = "",
        help: String? = nil,
        error: String? = nil,
        required: Bool = false,
        disabled: Bool = false,
        numeric: MuiInputNumericConfig? = nil,
        onCommit: (() -> Void)? = nil
    ) {
        self.label = label
        self._value = value
        self.placeholder = placeholder
        self.help = help
        self.error = error
        self.required = required
        self.disabled = disabled
        self.numeric = numeric
        self.onCommit = onCommit
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            MuiText(Self.displayLabel(label: label, required: required), variant: .toolLabel, color: .muted)

            MuiInput(
                value: $value,
                accessibilityLabel: label,
                placeholder: placeholder,
                numeric: numeric,
                error: error,
                disabled: disabled,
                onCommit: onCommit
            )

            // MuiInput already renders `error` under itself, so `help` only
            // shows when there's no error to avoid a doubled caption line.
            if let help, error == nil {
                MuiText(help, variant: .body, color: .muted)
            }
        }
        .opacity(disabled ? 0.45 : 1)
    }

    /// The label row's display text — appends a required-marker suffix.
    /// Public + static so this is unit-testable without rendering a view.
    public static func displayLabel(label: String, required: Bool) -> String {
        required ? "\(label) *" : label
    }
}

#Preview("MuiFormField — States") {
    struct Demo: View {
        @State private var name = ""
        @State private var email = "not-an-email"

        var body: some View {
            VStack(spacing: 16) {
                MuiFormField(label: "Display name", value: $name, placeholder: "Ada Lovelace", help: "Shown on shared albums", required: true)
                MuiFormField(label: "Email", value: $email, error: "Enter a valid email address")
                MuiFormField(label: "Locked", value: .constant("Read only"), disabled: true)
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
