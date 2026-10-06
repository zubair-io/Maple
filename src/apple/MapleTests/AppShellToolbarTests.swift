// AppShellToolbarTests.swift — Unit tests for AppShellToolbar item visibility (#4326).
//
// Tests that Settings button is visible in Browse mode on Mac/iPad, but hidden
// in Preview and Editor pages, while phone tab shell keeps Settings in the bottom
// tab bar.

import MapleCore
import SwiftUI
import XCTest

@testable import Maple

@MainActor
final class AppShellToolbarTests: XCTestCase {

  private func makeToolbar(
    isEditing: Bool,
    isCompact: Bool,
    searchAvailable: Bool = false
  ) -> AppShellToolbar {
    var displayMode = GridDisplayMode.fill
    let binding = Binding<GridDisplayMode>(
      get: { displayMode },
      set: { displayMode = $0 }
    )
    return AppShellToolbar(
      isEditing: isEditing,
      isCompact: isCompact,
      searchAvailable: searchAvailable,
      isSearchActive: false,
      browseDisplayMode: binding,
      onOpenSearch: {},
      onSettings: {}
    )
  }

  func testSettingsToolbarVisibilityOnDesktop() {
    // In Browse mode on Mac and iPad, Settings is visible in the toolbar.
    let browseToolbar = makeToolbar(isEditing: false, isCompact: false)
    XCTAssertTrue(browseToolbar.showsSettingsInToolbar)
    XCTAssertTrue(browseToolbar.showsGridDisplayMode)

    // In Preview and Editor modes on Mac and iPad, Settings is hidden in the toolbar.
    let editingToolbar = makeToolbar(isEditing: true, isCompact: false)
    XCTAssertFalse(editingToolbar.showsSettingsInToolbar)
    XCTAssertFalse(editingToolbar.showsGridDisplayMode)
  }

  func testSettingsToolbarVisibilityOnCompactPhone() {
    // On iPhone (compact shell), Settings lives in the bottom tab bar,
    // so it is never shown in the window toolbar.
    let browseToolbar = makeToolbar(isEditing: false, isCompact: true)
    XCTAssertFalse(browseToolbar.showsSettingsInToolbar)

    let editingToolbar = makeToolbar(isEditing: true, isCompact: true)
    XCTAssertFalse(editingToolbar.showsSettingsInToolbar)
  }

  func testSearchToolbarVisibility() {
    // On desktop, search appears only when available (cloud library).
    let desktopNoSearch = makeToolbar(isEditing: false, isCompact: false, searchAvailable: false)
    XCTAssertFalse(desktopNoSearch.showsSearchInToolbar)

    let desktopWithSearch = makeToolbar(isEditing: false, isCompact: false, searchAvailable: true)
    XCTAssertTrue(desktopWithSearch.showsSearchInToolbar)

    // On phone, search lives in the bottom tab bar.
    let phoneWithSearch = makeToolbar(isEditing: false, isCompact: true, searchAvailable: true)
    XCTAssertFalse(phoneWithSearch.showsSearchInToolbar)
  }
}
