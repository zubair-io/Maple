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
import MapleCore

// MARK: - Browse / Full-image toolbar

struct AppShellToolbar: ToolbarContent {
    /// True when AppShell is in the legacy Full-image mode (vs. Browse).
    /// Drives the window-toolbar Back chevron + Export. In the S5
    /// `.editing` mode this is FALSE — the `EditorView`'s own
    /// `EditorHeader` owns back/share/title, so the window toolbar must
    /// not duplicate them (#815).
    let isFullImage: Bool
    /// True when AppShell is in the S5 `.editing` mode (Mac/iPad pane
    /// shell). The `EditorView` renders its own full chrome
    /// (`EditorHeader`), so the window toolbar suppresses every
    /// browse-specific control (grid fill/fit, cloud view-mode) AND the
    /// full-image controls (back/export) — only the persistent
    /// Library/Search/Settings group survives, so the sidebar can still
    /// be toggled. Always false on iPhone (it never enters `.editing`).
    var isEditing: Bool = false
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
    /// True when the selected source is a Maple Cloud library — gates the
    /// trailing Timeline/Folder view-mode toggle (which only makes sense
    /// for cloud libraries). The toggle moved here from the sidebar (#782).
    let isCloudLibrary: Bool
    /// Current cloud view mode — drives the toggle's active tint. Ignored
    /// when `isCloudLibrary` is false.
    let cloudViewMode: CloudViewMode
    /// Grid fill/fit toggle — toolbar both reads (icon) and writes (tap).
    @Binding var browseDisplayMode: GridDisplayMode
    /// Grid zoom level — stepped by the − / + toolbar control and ⌘± (#1550).
    @Binding var browseZoomLevel: GridZoomLevel
    /// Tapped when the user hits the Back chevron in Full-image mode.
    let onBack: () -> Void
    /// Desktop only — toggles the sources sidebar column (the "Library" button).
    let onToggleSidebar: () -> Void
    /// Desktop only — opens the cloud search view (the "Search" button).
    let onOpenSearch: () -> Void
    /// Switch the current cloud library between Timeline and Folder view.
    /// Wired to `AppShell.setCloudViewMode`. Only invoked from the trailing
    /// toggle, which is shown only when `isCloudLibrary` is true.
    let onSetCloudViewMode: (CloudViewMode) -> Void
    /// Tapped when the user hits Export (also keyboard ⌘E).
    let onExport: () -> Void
    /// Triggered by the hidden ⌘O keyboard shortcut.
    let onOpenFolder: () -> Void
    /// Tapped when the user hits the Settings gear (also ⌘, on macOS).
    let onSettings: () -> Void
    /// True when BrowseViewModel is in multi-select mode (M1, #1236).
    /// Drives the "Select" / "Done" toolbar toggle.
    var isSelecting: Bool = false
    /// Tapped when the user hits the "Select" / "Done" multi-select toggle.
    /// nil hides the button (Full-image and edit modes).
    var onToggleSelect: (() -> Void)? = nil

    var body: some ToolbarContent {
        // `.navigation` placement lands on the LEADING edge of the title
        // bar (right of the sidebar-toggle, left of the title); the
        // header controls that follow use `.primaryAction` (TRAILING edge)
        // per the #782 UX request — only the Back chevron stays leading.
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
        // Lives on the TRAILING edge (`.primaryAction`) per the #782 UX
        // request — grid display + cloud view-mode controls cluster on the
        // right of the header, not next to the menu button.
        if !isFullImage && !isEditing {
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
        // Grid zoom − / + control — browse mode only, and not on iPhone (the
        // phone uses pinch-to-zoom; #1550). Sits next to the fill/fit button.
        // + zooms in (fewer columns, bigger cells); − zooms out (more columns,
        // smaller cells). Disabled at the clamped ends. ⌘= is the conventional
        // "zoom in" key on Mac (same as ⌘+, which is actually ⌘Shift+= on US
        // keyboards); ⌘- is zoom out.
        if !isFullImage && !isEditing && !isCompact {
            ToolbarItem(placement: .primaryAction) {
                HStack(spacing: 2) {
                    Button {
                        withAnimation(.smooth) { browseZoomLevel = browseZoomLevel.zoomedOut() }
                    } label: {
                        Image(systemName: "minus")
                            .foregroundStyle(MapleTokens.textMuted)
                    }
                    .disabled(browseZoomLevel == .dense)
                    .keyboardShortcut("-", modifiers: .command)
                    .accessibilityLabel("Zoom out grid")
                    .accessibilityIdentifier("grid-zoom-out")

                    Button {
                        withAnimation(.smooth) { browseZoomLevel = browseZoomLevel.zoomedIn() }
                    } label: {
                        Image(systemName: "plus")
                            .foregroundStyle(MapleTokens.textMuted)
                    }
                    .disabled(browseZoomLevel == .fullWidth)
                    .keyboardShortcut("=", modifiers: .command)
                    .accessibilityLabel("Zoom in grid")
                    .accessibilityIdentifier("grid-zoom-in")
                }
            }
        }
        // Multi-select toggle (M1, #1236) — Browse mode only, not in edit /
        // full-image. Shows "Select" when idle, "Done" when active. Only
        // rendered when the parent provides the `onToggleSelect` closure.
        if !isFullImage && !isEditing, let onToggleSelect {
            ToolbarItem(placement: .primaryAction) {
                Button(isSelecting ? "Done" : "Select") {
                    onToggleSelect()
                }
                .accessibilityLabel(isSelecting
                    ? "Exit selection mode"
                    : "Enter multi-select mode to choose images for panorama merge")
                .accessibilityIdentifier("multi-select-toggle")
            }
        }
        // Cloud Timeline/Folder view-mode toggle — browse mode, cloud
        // libraries only. Moved here from the sidebar's per-server header
        // (#782) so it sits to the right of the fill/fit control. Tapping
        // re-routes the current library through the chosen view mode via
        // `AppShell.setCloudViewMode`.
        if !isFullImage && !isEditing && isCloudLibrary {
            ToolbarItem(placement: .primaryAction) {
                cloudViewModeToggle
            }
        }
        // Export / share — Full-image only (you share the photo you're
        // viewing). Removed from the Browse header (#782); on the trailing
        // edge alongside the other header controls.
        if isFullImage {
            ToolbarItem(placement: .primaryAction) {
                Button("Export", systemImage: "square.and.arrow.up") {
                    onExport()
                }
                .disabled(!hasSelection)
                .keyboardShortcut("e", modifiers: .command)
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

    /// Single-button Timeline ↔ Folder toggle for the trailing header,
    /// shown only for cloud libraries. One-button shape mirrors the
    /// adjacent fill/fit toggle: the icon shows the CURRENT mode
    /// (calendar = Timeline, folder = Folder) and a tap flips to the
    /// other. (Replaced the earlier two-icon pair — #782.)
    @ViewBuilder
    private var cloudViewModeToggle: some View {
        Button {
            onSetCloudViewMode(cloudViewMode == .timeline ? .folder : .timeline)
        } label: {
            Image(systemName: cloudViewMode == .timeline ? "calendar" : "folder")
                .foregroundStyle(MapleTokens.textMuted)
        }
        .accessibilityLabel(cloudViewMode == .timeline
                            ? "Switch to Folder view"
                            : "Switch to Timeline view")
        .accessibilityIdentifier("cloud-view-mode-toggle")
    }
}
