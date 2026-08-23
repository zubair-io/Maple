// MuiDialog.swift — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Prompt, confirm, or choice — built from Popover, Text, Input,
// Button. Mirrors MuiPopover's dismiss contract (outside tap, Escape,
// focus moves onto the panel on open) but is modal rather than anchored:
// a fixed full-viewport scrim rather than a panel positioned against a
// trigger, so it doesn't compose `.muiPopover` directly — same reasoning
// the web reference gives for not reusing `<mui-popover>` here.
//
// Rendered as a plain view the caller places in a `ZStack`/`.overlay` over
// its own content (same "caller owns placement" contract as
// `MuiValueChip`), rather than a view modifier — a full-viewport scrim has
// no anchor to attach to.

import SwiftUI

public enum MuiDialogVariant: Sendable {
    case confirm, prompt
}

public struct MuiDialog: View {
    public let isPresented: Bool
    public let title: String
    public let message: String?
    public let variant: MuiDialogVariant
    public let confirmLabel: String
    public let cancelLabel: String
    public let destructive: Bool
    public let promptPlaceholder: String
    @Binding public var promptValue: String
    /// Fires with `promptValue` for the `prompt` variant, or an empty
    /// string for `confirm` — same payload contract as the web reference,
    /// which always emits the (possibly-unused) prompt field.
    public let confirmed: ((String) -> Void)?
    /// Fires on Escape, an outside tap, or the Cancel button.
    public let dismissed: (() -> Void)?

    @FocusState private var panelFocused: Bool

    public init(
        isPresented: Bool,
        title: String,
        message: String? = nil,
        variant: MuiDialogVariant = .confirm,
        confirmLabel: String = "Confirm",
        cancelLabel: String = "Cancel",
        destructive: Bool = false,
        promptPlaceholder: String = "",
        promptValue: Binding<String> = .constant(""),
        confirmed: ((String) -> Void)? = nil,
        dismissed: (() -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.title = title
        self.message = message
        self.variant = variant
        self.confirmLabel = confirmLabel
        self.cancelLabel = cancelLabel
        self.destructive = destructive
        self.promptPlaceholder = promptPlaceholder
        self._promptValue = promptValue
        self.confirmed = confirmed
        self.dismissed = dismissed
    }

    public var body: some View {
        Group {
            if isPresented {
                ZStack {
                    Color.black.opacity(0.55)
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { dismissed?() }

                    panel
                        .padding(MuiTokens.spacingLg)
                        .background(MuiTokens.surface, in: RoundedRectangle(cornerRadius: MuiTokens.radiusLg, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: MuiTokens.radiusLg, style: .continuous)
                                .stroke(MuiTokens.border, lineWidth: 1)
                        )
                        .shadow(color: .black.opacity(0.4), radius: 24, y: 8)
                        .frame(maxWidth: 420)
                        .focusable()
                        .focused($panelFocused)
                        #if os(macOS)
                        .onKeyPress(.escape) {
                            dismissed?()
                            return .handled
                        }
                        #endif
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel(title)
                        .task { panelFocused = true }
                }
                .transition(.opacity)
                .animation(MuiTokens.Motion.sheetPresent, value: isPresented)
            }
        }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            MuiText(title, variant: .rowLabel, block: true)

            if let message {
                MuiText(message, variant: .body, color: .muted, block: true)
            }

            if variant == .prompt {
                MuiInput(value: $promptValue, accessibilityLabel: title, placeholder: promptPlaceholder)
            }

            HStack(spacing: MuiTokens.spacingSm) {
                Spacer()
                MuiButton(label: cancelLabel, variant: .ghost) { dismissed?() }
                MuiButton(label: confirmLabel, variant: destructive ? .destructive : .primary) {
                    confirmed?(Self.confirmPayload(variant: variant, promptValue: promptValue))
                }
            }
        }
    }

    /// The payload a confirm action emits — `promptValue` for the `prompt`
    /// variant, or an empty string for `confirm` (which never touches
    /// `promptValue`). Public + static so this is unit-testable without
    /// rendering a view.
    public static func confirmPayload(variant: MuiDialogVariant, promptValue: String) -> String {
        variant == .prompt ? promptValue : ""
    }
}

#Preview("MuiDialog — Confirm") {
    ZStack {
        MuiTokens.bg
        MuiDialog(
            isPresented: true,
            title: "Delete 3 photos?",
            message: "This can't be undone.",
            confirmLabel: "Delete",
            destructive: true
        )
    }
}

#Preview("MuiDialog — Prompt") {
    struct Demo: View {
        @State private var name = ""

        var body: some View {
            ZStack {
                MuiTokens.bg
                MuiDialog(
                    isPresented: true,
                    title: "Rename album",
                    variant: .prompt,
                    confirmLabel: "Rename",
                    promptPlaceholder: "Album name",
                    promptValue: $name
                )
            }
        }
    }
    return Demo()
}
