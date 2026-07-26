// AppShellToolbar.swift — Browse-mode toolbar content for AppShell.
// Extracted from AppShell.swift as part of the multi-PR AppShell split
// (#123, slice 2).
//
// Surface notes: the toolbar reads/writes a small slice of AppShell's
// state. Rather than make those `@State` properties internal (the brief's
// risk inventory flags state-widening as a hazard), this sibling
// `ToolbarContent` takes explicit parameters — bools for the read-only
// flags, a binding for the grid display-mode toggle, and closures for
// every action. `Mode` stays private to AppShell; we only need `isEditing`
// here.
//
// The legacy Full-image mode's Back chevron + Export toolbar items were
// retired in #1807 along with `FullImageView` / `Mode.fullImage` — both the
// S5 editor (`PillHeader`) and the Fast-Preview surface ship their own
// back/share chrome, so the window toolbar never needs to duplicate them.

import SwiftUI
import MapleCore

// MARK: - Browse toolbar

struct AppShellToolbar: ToolbarContent {
    /// True when AppShell's center surface owns its own chrome (the S5
    /// `.editing` editor OR the Fast-Preview `.preview` surface, Mac/iPad
    /// pane shell). Those views render their own header (back + filename),
    /// so the window toolbar suppresses every browse-specific control (grid
    /// fill/fit, select) — only the persistent Library/Search/Settings group
    /// survives, so the sidebar can still be toggled. Always false on
    /// iPhone (it never enters these pane-shell modes).
    var isEditing: Bool = false
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
    /// Desktop only — opens the cloud search view (the "Search" button).
    let onOpenSearch: () -> Void
    /// Triggered by the hidden ⌘O keyboard shortcut.
    let onOpenFolder: () -> Void
    /// Tapped when the user hits the Settings gear (also ⌘, on macOS).
    let onSettings: () -> Void
    /// True when BrowseViewModel is in multi-select mode (M1, #1236).
    /// Drives the "Select" / "Done" toolbar toggle.
    var isSelecting: Bool = false
    /// Tapped when the user hits the "Select" / "Done" multi-select toggle.
    /// nil hides the button (edit mode).
    var onToggleSelect: (() -> Void)? = nil

    var body: some ToolbarContent {
        // `.primaryAction` lands on the TRAILING edge of the title bar per
        // the #782 UX request — header controls cluster on the right rather
        // than across the title bar. The library-search magnifying glass was
        // removed in #692; search is now a top-level destination (bottom tab
        // on iPhone, the trailing Library/Search/Settings group on desktop).
        //
        // Grid fill/fit toggle — only relevant in browse mode. Persists for
        // the session via @State on AppShell. The button shows the OPPOSITE
        // icon as the action target (see `GridDisplayMode.toggleIconName`).
        if !isEditing {
            ToolbarItem(placement: .primaryAction) {
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
        // Multi-select toggle (M1, #1236) — Browse mode only, not in edit.
        // Shows a checkbox icon ("Select") when idle, "Done" when active. The
        // checkbox glyph (checkmark.square) matches the Material
        // select_check_box semantics requested in the design spec. Only
        // rendered when the parent provides the `onToggleSelect` closure.
        if !isEditing, let onToggleSelect {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    onToggleSelect()
                } label: {
                    if isSelecting {
                        Text("Done")
                    } else {
                        Image(systemName: "checkmark.square")
                            .foregroundStyle(MapleTokens.textMuted)
                    }
                }
                .accessibilityLabel(isSelecting
                    ? "Exit selection mode"
                    : "Enter multi-select mode to choose images for panorama merge")
                .accessibilityIdentifier("multi-select-toggle")
            }
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
        // Note: the sidebar-toggle button (sidebar.left / "Library") has been
        // removed from this group — sidebar visibility is controlled via the
        // NavigationSplitView's built-in toggle and the ⌘\ shortcut.
        if !isCompact {
            ToolbarItemGroup(placement: .primaryAction) {
                // Omit the search button entirely off-cloud — disabled is
                // confusing on a source that has no /api/search endpoint.
                if searchAvailable {
                    Button {
                        onOpenSearch()
                    } label: {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(isSearchActive
                                             ? MapleTokens.primary : MapleTokens.textMuted)
                    }
                    .accessibilityLabel("Search")
                    .accessibilityIdentifier("search-toggle")
                }

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
