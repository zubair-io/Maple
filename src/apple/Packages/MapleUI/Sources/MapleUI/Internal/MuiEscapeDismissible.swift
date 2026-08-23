// MuiEscapeDismissible.swift — macOS Escape-to-dismiss + auto-focus-on-open,
// shared by the modal Templates (Overlay Shell, Sheet Shell, Drawer Shell —
// unified-component-catalog.md §5). Mirrors the inline block MuiDialog
// already carries (focusable + focused + `#if os(macOS)` `.onKeyPress`),
// factored out here because three Templates need it verbatim where
// MuiDialog only needed it once — the "generalize on a second real caller"
// bar from the repo's YAGNI principle is cleared three times over.

import SwiftUI

private struct MuiEscapeDismissibleModifier: ViewModifier {
    let onDismiss: (() -> Void)?

    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        content
            .focusable()
            .focused($focused)
            #if os(macOS)
            .onKeyPress(.escape) {
                onDismiss?()
                return .handled
            }
            #endif
            .task { focused = true }
    }
}

extension View {
    /// Moves keyboard focus onto this view when it appears, and — on macOS
    /// only — dismisses via Escape. iOS/iPadOS have no hardware-Escape
    /// convention, so `onDismiss` there stays reachable only through the
    /// scrim tap or an explicit control, matching MuiDialog's existing
    /// platform split.
    func muiEscapeDismissible(onDismiss: (() -> Void)?) -> some View {
        modifier(MuiEscapeDismissibleModifier(onDismiss: onDismiss))
    }
}
