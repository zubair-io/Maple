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
    /// True on the compact (iPhone) shell, where Library / Search / Settings
    /// live in the bottom tab bar. Desktop (Mac / iPad) renders them as a
    /// trailing toolbar group instead.
    let isCompact: Bool
    /// True when search can run — i.e. a Maple Cloud library is selected.
    /// Gates (disables) the desktop Search button.
    let searchAvailable: Bool
    /// True when the search UI is currently showing — drives the Search tint.
    let isSearchActive: Bool
    /// Grid fill/fit toggle — toolbar both reads (icon) and writes (tap).
    @Binding var browseDisplayMode: GridDisplayMode
    /// Tapped when the user hits the Back chevron in Full-image mode.
    let onBack: () -> Void
    /// Desktop only — toggles the sources sidebar column (the "Library" button).
    let onToggleSidebar: () -> Void
    /// Desktop only — opens the cloud search view (the "Search" button).
    let onOpenSearch: () -> Void
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
        // Back chevron — Full-image only. The library-search magnifying glass
        // was removed in #692; search is now a top-level destination (bottom
        // tab on iPhone, the trailing Library/Search/Settings group on desktop).
        if isFullImage {
            ToolbarItem(placement: .navigation) {
                Button("Back", systemImage: "chevron.left") {
                    onBack()
                }
                .keyboardShortcut(.escape, modifiers: [])
                .accessibilityLabel("Back to Library")
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
        // ⌘O keyboard shortcut — desktop only. Omitted on the compact (iPhone)
        // shell: there's no hardware ⌘O there, and a hidden trailing item would
        // otherwise render as an empty glass capsule (iOS 26 groups toolbar
        // items into capsules) now that the Settings gear has moved out. #692.
        if !isCompact {
            ToolbarItem(placement: .automatic) {
                Button("Open Folder", systemImage: "folder.badge.plus") {
                    onOpenFolder()
                }
                .keyboardShortcut("o", modifiers: .command)
                // Hide from the visible toolbar — keyboard shortcut only.
                .hidden()
                .accessibilityHidden(true)
            }
        }
        // Trailing primary nav — desktop (Mac / iPad) only. iPhone gets these
        // three as the bottom tab bar (Library / Search / Settings), so the
        // compact shell renders nothing here. Mirrors the iOS footer. #692.
        if !isCompact {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    onToggleSidebar()
                } label: {
                    Image(systemName: "sidebar.left")
                        .foregroundStyle(MapleTokens.textMuted)
                }
                .accessibilityLabel("Library")
                .accessibilityIdentifier("library-toggle")

                Button {
                    onOpenSearch()
                } label: {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(isSearchActive
                                         ? MapleTokens.primary : MapleTokens.textMuted)
                }
                .disabled(!searchAvailable)
                .accessibilityLabel("Search")
                .accessibilityIdentifier("search-toggle")

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
}
