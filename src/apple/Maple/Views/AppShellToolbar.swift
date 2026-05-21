// AppShellToolbar.swift — Browse/Full-image toolbar content for AppShell.
// Extracted from AppShell.swift as part of the multi-PR AppShell split
// (#123, slice 2).
//
// Surface notes: the toolbar reads/writes a small slice of AppShell's
// state. Rather than make those `@State` properties internal (the brief's
// risk inventory flags state-widening as a hazard), this sibling
// `ToolbarContent` takes explicit parameters — bools for the read-only
// flags, a binding for the grid display-mode toggle, and closures for
// every action. `Mode` stays private to AppShell; we only need
// `isFullImage` here.

import SwiftUI

// MARK: - Browse / Full-image toolbar

struct AppShellToolbar: ToolbarContent {
    /// True when AppShell is in Full-image mode (vs. Browse).
    let isFullImage: Bool
    /// True when an `EditSession` is selected — gates the Export button.
    let hasSelection: Bool
    /// Grid fill/fit toggle — toolbar both reads (icon) and writes (tap).
    @Binding var browseDisplayMode: GridDisplayMode
    /// Tapped when the user hits the Back chevron in Full-image mode.
    let onBack: () -> Void
    /// Tapped when the user hits Export (also keyboard ⌘E).
    let onExport: () -> Void
    /// Triggered by the hidden ⌘O keyboard shortcut.
    let onOpenFolder: () -> Void
    /// Tapped when the user hits the Settings gear (also ⌘, on macOS).
    let onSettings: () -> Void

    var body: some ToolbarContent {
        // Toolbar items at `.navigation` placement land on the LEADING edge
        // of the title bar — right of the sidebar-toggle button, left of
        // the navigationTitle. When the sidebar is closed the placement
        // collapses to "right after the menu/sidebar button, before the
        // image name." Per UX request: back/share/zoom controls live in
        // the header next to the menu button rather than at the trailing
        // edge after the title.
        ToolbarItem(placement: .navigation) {
            if isFullImage {
                Button("Back", systemImage: "chevron.left") {
                    onBack()
                }
                .keyboardShortcut(.escape, modifiers: [])
                .accessibilityLabel("Back to Library")
            } else {
                // TODO(UI-search): wire library search.
                Button {
                    // no-op
                } label: {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(MapleTokens.textMuted)
                }
                .accessibilityLabel("Search")
            }
        }
        // Grid fill/fit toggle — only relevant in browse mode. Persists for
        // the session via @State on AppShell. The button shows the OPPOSITE
        // icon as the action target (see `GridDisplayMode.toggleIconName`).
        // Placement .navigation per the same UX rule as the rest of the
        // toolbar — header controls cluster on the leading edge, right of
        // the sidebar-toggle button.
        if !isFullImage {
            ToolbarItem(placement: .navigation) {
                Button {
                    browseDisplayMode = browseDisplayMode.toggled
                } label: {
                    Image(systemName: browseDisplayMode.toggleIconName)
                        .foregroundStyle(MapleTokens.textMuted)
                }
                .accessibilityLabel(browseDisplayMode.toggleAccessibilityLabel)
                .accessibilityIdentifier("browse-grid-display-mode-toggle")
            }
        }
        ToolbarItem(placement: .navigation) {
            Button("Export", systemImage: "square.and.arrow.up") {
                onExport()
            }
            .disabled(!hasSelection)
            .keyboardShortcut("e", modifiers: .command)
        }
        // ⌘O still works even though the button has moved into the sidebar.
        ToolbarItem(placement: .automatic) {
            Button("Open Folder", systemImage: "folder.badge.plus") {
                onOpenFolder()
            }
            .keyboardShortcut("o", modifiers: .command)
            // Hide from the visible toolbar — keyboard shortcut only.
            .hidden()
            .accessibilityHidden(true)
        }
        ToolbarItem(placement: .automatic) {
            Button("Settings", systemImage: "gear") {
                onSettings()
            }
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("settings-button")
            #if os(macOS)
            .keyboardShortcut(",", modifiers: .command)
            #endif
        }
    }
}
