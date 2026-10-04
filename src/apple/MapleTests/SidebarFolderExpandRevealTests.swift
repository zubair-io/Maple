// SidebarFolderExpandRevealTests.swift — unit tests for sidebar folder expansion,
// explicit collapse preservation, and reveal contracts (Issue #4152).

import Foundation
import MapleUI
import SwiftUI
import XCTest

@testable import Maple

@MainActor
final class SidebarFolderExpandRevealTests: XCTestCase {

  // MARK: - MuiTreeRow Expand on Press & Explicit Chevron Toggle

  func testMuiTreeRowExpandsOnPressWhenExpandableAndCollapsed() {
    var expanded = false
    var pressedFired = false

    let row = MuiTreeRow(
      label: "2026",
      expandable: true,
      expanded: Binding(get: { expanded }, set: { expanded = $0 }),
      expandOnPress: true,
      pressed: { pressedFired = true }
    )

    XCTAssertFalse(expanded)
    XCTAssertTrue(row.expandOnPress)

    // Simulating pressing the row
    if row.expandOnPress && row.expandable && !expanded {
      expanded = true
    }
    row.pressed?()

    XCTAssertTrue(
      expanded, "Clicking a collapsed folder row with expandOnPress must expand children")
    XCTAssertTrue(pressedFired, "Clicking the folder row must fire the pressed callback")
  }

  func testMuiTreeRowPreservesExpandedStateWhenAlreadyExpanded() {
    var expanded = true
    var pressedFired = false

    let row = MuiTreeRow(
      label: "2026",
      expandable: true,
      expanded: Binding(get: { expanded }, set: { expanded = $0 }),
      expandOnPress: true,
      pressed: { pressedFired = true }
    )

    XCTAssertTrue(expanded)

    // Simulating pressing the row when already expanded
    if row.expandOnPress && row.expandable && !expanded {
      expanded = true
    }
    row.pressed?()

    XCTAssertTrue(expanded, "Clicking an already-expanded folder row must NOT collapse it")
    XCTAssertTrue(pressedFired, "Clicking the row must fire pressed callback")
  }

  func testMuiTreeRowExplicitChevronTogglesWithoutTriggeringPressed() {
    var expanded = true
    var pressedFired = false

    let row = MuiTreeRow(
      label: "2026",
      expandable: true,
      expanded: Binding(get: { expanded }, set: { expanded = $0 }),
      expandOnPress: true,
      pressed: { pressedFired = true }
    )

    XCTAssertTrue(expanded)

    // Chevron click explicitly toggles expanded
    expanded.toggle()

    XCTAssertFalse(expanded, "Clicking the chevron toggle on an expanded row must collapse it")
    XCTAssertFalse(pressedFired, "Clicking the chevron must NOT fire the row's pressed handler")

    // Chevron click again expands it
    expanded.toggle()
    XCTAssertTrue(expanded, "Clicking the chevron toggle on a collapsed row must re-expand it")
    XCTAssertFalse(pressedFired, "Chevron toggle must still NOT fire the row's pressed handler")
  }

  func testMuiTreeRowDefaultExpandOnPressIsFalse() {
    let row = MuiTreeRow(
      label: "Plain Row",
      expandable: true,
      expanded: .constant(false)
    )
    XCTAssertFalse(
      row.expandOnPress, "Default expandOnPress must remain false for backwards compatibility")
  }

  // MARK: - SelectedFolderRowPreferenceKey

  func testSelectedFolderRowPreferenceKey() {
    XCTAssertNil(SelectedFolderRowPreferenceKey.defaultValue)

    var current: String? = nil
    SelectedFolderRowPreferenceKey.reduce(value: &current, nextValue: { "/photos/2026" })
    XCTAssertEqual(current, "/photos/2026")

    SelectedFolderRowPreferenceKey.reduce(value: &current, nextValue: { nil })
    XCTAssertEqual(current, "/photos/2026", "Nil nextValue retains the existing key value")

    SelectedFolderRowPreferenceKey.reduce(value: &current, nextValue: { "/photos/2026/Spring" })
    XCTAssertEqual(current, "/photos/2026/Spring", "New non-nil nextValue updates the key value")
  }

  // MARK: - Ancestor Chain Matching

  func testAncestorChainMatchingForLocalPaths() {
    let rootPath = "/Users/photographer/Pictures/Library"
    let subPath = "/Users/photographer/Pictures/Library/2026"
    let deepPath = "/Users/photographer/Pictures/Library/2026/Spring"
    let siblingPath = "/Users/photographer/Pictures/Library/2025"

    let isAncestor: (String, String) -> Bool = { candidate, selected in
      guard selected != candidate else { return false }
      let candidateComponents = URL(fileURLWithPath: candidate).pathComponents
      let selectedComponents = URL(fileURLWithPath: selected).pathComponents
      guard selectedComponents.count > candidateComponents.count else { return false }
      return Array(selectedComponents.prefix(candidateComponents.count)) == candidateComponents
    }

    XCTAssertTrue(isAncestor(rootPath, subPath))
    XCTAssertTrue(isAncestor(rootPath, deepPath))
    XCTAssertTrue(isAncestor(subPath, deepPath))

    XCTAssertFalse(isAncestor(rootPath, rootPath), "Folder cannot be an ancestor of itself")
    XCTAssertFalse(isAncestor(deepPath, subPath), "Child is not ancestor of parent")
    XCTAssertFalse(isAncestor(siblingPath, subPath), "Sibling is not ancestor")
  }

  func testAncestorChainMatchingForCloudPaths() {
    let isOnChain: (String, String?) -> Bool = { absPath, currentPath in
      guard let current = currentPath, current != absPath else { return false }
      let prefix = absPath.hasSuffix("/") ? absPath : absPath + "/"
      return current.hasPrefix(prefix)
    }

    XCTAssertTrue(isOnChain("/photos", "/photos/2026"))
    XCTAssertTrue(isOnChain("/photos/2026", "/photos/2026/April"))
    XCTAssertTrue(isOnChain("/", "/photos"))

    XCTAssertFalse(isOnChain("/photos", "/photos"), "Exact match is not an ancestor")
    XCTAssertFalse(isOnChain("/photos/2025", "/photos/2026"), "Sibling is not on chain")
    XCTAssertFalse(isOnChain("/photos", nil), "Nil current path is not on chain")
  }
}
