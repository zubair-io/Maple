// MuiInlineRenameField.swift — Maple UI Molecules-L1
// (unified-component-catalog.md §2.1). Edit-in-place name: renders as
// static text until activated, then swaps to an Input with commit/cancel,
// built from Input + Text.

import SwiftUI

/// Tap the display text to enter editing mode. Commits on Return or on
/// losing focus (mirrors the web reference's Enter/blur-commit contract);
/// Escape cancels back to the prior value (macOS only — `onExitCommand` has
/// no iOS equivalent, so the Cancel affordance there is losing focus without
/// having typed Return, which still discards the draft on commit's "no
/// change" check... except a genuine in-place edit *does* count as a
/// change, so iOS callers rely on the system keyboard's dismiss instead).
public struct MuiInlineRenameField: View {
    @Binding public var value: String
    public let accessibilityLabel: String
    public let disabled: Bool
    public let renamed: ((String) -> Void)?

    @State private var editing = false
    @State private var draft = ""
    @State private var justCommitted = false
    @FocusState private var isFocused: Bool

    public init(
        value: Binding<String>,
        accessibilityLabel: String = "Name",
        disabled: Bool = false,
        renamed: ((String) -> Void)? = nil
    ) {
        self._value = value
        self.accessibilityLabel = accessibilityLabel
        self.disabled = disabled
        self.renamed = renamed
    }

    public var body: some View {
        Group {
            if editing {
                MuiInput(value: $draft, accessibilityLabel: accessibilityLabel, size: .sm, onCommit: commit)
                    .focused($isFocused)
                    #if os(macOS)
                    .onExitCommand { cancel() }
                    #endif
                    .onChange(of: isFocused) { _, focused in
                        if !focused { commit() }
                    }
                    .task { isFocused = true }
            } else {
                Button {
                    startEditing()
                } label: {
                    HStack(spacing: 4) {
                        MuiText(value, variant: .rowLabel, truncate: true)
                        if justCommitted {
                            MuiIcon(name: "checkmark", size: .xs, color: MuiTokens.successText)
                        }
                    }
                    .frame(minHeight: 44, alignment: .leading)
                }
                .buttonStyle(.plain)
                .disabled(disabled)
                .opacity(disabled ? 0.45 : 1)
                .accessibilityLabel("Rename \(value)")
            }
        }
    }

    private func startEditing() {
        guard !disabled else { return }
        draft = value
        justCommitted = false
        editing = true
    }

    private func commit() {
        guard editing else { return }
        editing = false
        guard let next = Self.commitResult(current: value, draft: draft) else { return }
        value = next
        renamed?(next)
        justCommitted = true
    }

    private func cancel() {
        editing = false
    }

    /// The committed value for a rename attempt — `nil` when the draft is
    /// blank (after trimming) or unchanged from the current value, in which
    /// case the caller discards the edit rather than committing a no-op.
    /// Public + static so this is unit-testable without rendering a view.
    public static func commitResult(current: String, draft: String) -> String? {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != current else { return nil }
        return trimmed
    }
}

#Preview("MuiInlineRenameField") {
    struct Demo: View {
        @State private var name = "IMG_0042.dng"

        var body: some View {
            VStack(alignment: .leading, spacing: 12) {
                MuiInlineRenameField(value: $name)
                MuiInlineRenameField(value: .constant("Locked album"), disabled: true)
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
