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

import MapleCore
import MapleUI
import SwiftUI

// MARK: - Browse toolbar

struct AppShellToolbar: ToolbarContent {
  /// True when AppShell's center surface owns its own chrome (the S5
  /// `.editing` editor OR the Fast-Preview `.preview` surface, Mac/iPad
  /// pane shell). Those views render their own header (back + filename),
  /// so the window toolbar suppresses every browse-specific control (grid
  /// fill/fit, select) and Settings — only search survives (when available).
  /// Always false on iPhone (it never enters these pane-shell modes).
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
  /// Tapped when the user hits the Settings gear (also ⌘, on macOS).
  let onSettings: () -> Void
  /// True when BrowseViewModel is in multi-select mode (M1, #1236).
  /// Drives the checkbox / compact completion-icon toolbar toggle.
  var isSelecting: Bool = false
  /// Tapped when the user hits the "Select" / "Done" multi-select toggle.
  /// nil hides the button (edit mode).
  var onToggleSelect: (() -> Void)? = nil

  /// Whether the Settings control appears in the window toolbar. Visible in
  /// Browse mode on desktop (Mac / iPad), but hidden on Preview and Editor pages
  /// (#4326). iPhone renders Settings in the bottom tab bar.
  var showsSettingsInToolbar: Bool {
    !isCompact && !isEditing
  }

  /// Whether the Search control appears in the window toolbar. Visible on
  /// desktop (Mac / iPad) when cloud search is available.
  var showsSearchInToolbar: Bool {
    !isCompact && searchAvailable
  }

  /// Whether the grid fill/fit display mode control appears in the toolbar.
  var showsGridDisplayMode: Bool {
    !isEditing
  }

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
    if showsGridDisplayMode {
      ToolbarItem(placement: .primaryAction) {
        Button {
          browseDisplayMode = browseDisplayMode.toggled
        } label: {
          MuiIcon(name: browseDisplayMode.toggleIconName, size: .sm)
            .foregroundStyle(MapleTokens.textMuted)
        }
        .accessibilityLabel(browseDisplayMode.toggleAccessibilityLabel)
        .accessibilityIdentifier("browse-grid-display-mode-toggle")
      }
    }
    // Multi-select toggle (M1, #1236) — Browse mode only, not in edit.
    // Shows a checkbox icon ("Select") when idle, a checkmark when active. The
    // checkbox glyph (checkmark.square) matches the Material
    // select_check_box semantics requested in the design spec. Only
    // rendered when the parent provides the `onToggleSelect` closure.
    if !isEditing, let onToggleSelect {
      ToolbarItem(placement: .primaryAction) {
        Button {
          onToggleSelect()
        } label: {
          if isSelecting {
            MuiIcon(name: "check", size: .sm)
              .foregroundStyle(MapleTokens.textMuted)
          } else {
            MuiIcon(name: "check_box", size: .sm)
              .foregroundStyle(MapleTokens.textMuted)
          }
        }
        .accessibilityLabel(
          isSelecting
            ? "Exit selection mode"
            : (FeatureFlags.isPanoramaEnabled
              ? "Enter multi-select mode to choose images for panorama merge"
              : "Enter multi-select mode")
        )
        .accessibilityIdentifier("multi-select-toggle")
      }
    }
    // Trailing primary nav — desktop (Mac / iPad) only. iPhone gets these
    // three as the bottom tab bar (Library / Search / Settings), so the
    // compact shell renders nothing here. Mirrors the iOS footer. #692.
    // Note: the sidebar-toggle button (sidebar.left / "Library") has been
    // removed from this group — sidebar visibility is controlled via the
    // NavigationSplitView's built-in toggle and the ⌘\ shortcut.
    //
    // In #4326:
    // - The hidden ⌘O ToolbarItem was removed to eliminate reserved empty
    //   toolbar space to the left of Settings on Mac and iPad. Keyboard
    //   shortcuts are hosted at the pane shell level.
    // - Settings button is visible in Browse (!isEditing), but hidden on
    //   Preview and Editor pages.
    if showsSearchInToolbar || showsSettingsInToolbar {
      ToolbarItemGroup(placement: .primaryAction) {
        // Omit the search button entirely off-cloud — disabled is
        // confusing on a source that has no /api/search endpoint.
        if showsSearchInToolbar {
          Button {
            onOpenSearch()
          } label: {
            MuiIcon(name: "search", size: .sm)
              .foregroundStyle(
                isSearchActive
                  ? MapleTokens.primary : MapleTokens.textMuted)
          }
          .accessibilityLabel("Search")
          .accessibilityIdentifier("search-toggle")
        }

        if showsSettingsInToolbar {
          Button("Settings", systemImage: "gear") {
            onSettings()
          }
          .accessibilityLabel("Settings")
          .accessibilityIdentifier("settings-button")
        }
      }
    }
  }
}
