// SidebarFolderExpandRevealTests.swift — unit tests for sidebar folder expansion,
// explicit chevron toggle preservation, and reveal contracts (Issue #4152).

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

    // Trigger row press action through production handler
    row.handleRowPress()

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

    // Trigger row press action through production handler
    row.handleRowPress()

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

    // Chevron click explicitly toggles expanded via production handler
    row.handleChevronToggle()

    XCTAssertFalse(expanded, "Clicking the chevron toggle on an expanded row must collapse it")
    XCTAssertFalse(pressedFired, "Clicking the chevron must NOT fire the row's pressed handler")

    // Chevron click again expands it
    row.handleChevronToggle()
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

  // MARK: - Production Ancestor Chain & Row ID Matching (SidebarReveal)

  func testAncestorChainMatchingForLocalPaths() {
    let root = URL(fileURLWithPath: "/Users/photographer/Pictures/Library")
    let sub = URL(fileURLWithPath: "/Users/photographer/Pictures/Library/2026")
    let deep = "/Users/photographer/Pictures/Library/2026/Spring"
    let sibling = URL(fileURLWithPath: "/Users/photographer/Pictures/Library/2025")

    XCTAssertTrue(SidebarReveal.isLocalAncestor(candidate: root, selectedPath: sub.path))
    XCTAssertTrue(SidebarReveal.isLocalAncestor(candidate: root, selectedPath: deep))
    XCTAssertTrue(SidebarReveal.isLocalAncestor(candidate: sub, selectedPath: deep))

    XCTAssertFalse(
      SidebarReveal.isLocalAncestor(candidate: root, selectedPath: root.path),
      "Folder cannot be an ancestor of itself")
    XCTAssertFalse(
      SidebarReveal.isLocalAncestor(candidate: URL(fileURLWithPath: deep), selectedPath: sub.path),
      "Child is not ancestor of parent")
    XCTAssertFalse(
      SidebarReveal.isLocalAncestor(candidate: sibling, selectedPath: sub.path),
      "Sibling is not ancestor")
  }

  func testAncestorChainMatchingForCloudPaths() {
    XCTAssertTrue(
      SidebarReveal.isCloudAncestor(candidatePath: "/photos", currentPath: "/photos/2026"))
    XCTAssertTrue(
      SidebarReveal.isCloudAncestor(
        candidatePath: "/photos/2026", currentPath: "/photos/2026/April"))
    XCTAssertTrue(SidebarReveal.isCloudAncestor(candidatePath: "/", currentPath: "/photos"))

    XCTAssertFalse(
      SidebarReveal.isCloudAncestor(candidatePath: "/photos", currentPath: "/photos"),
      "Exact match is not an ancestor")
    XCTAssertFalse(
      SidebarReveal.isCloudAncestor(candidatePath: "/photos/2025", currentPath: "/photos/2026"),
      "Sibling is not on chain")
    XCTAssertFalse(
      SidebarReveal.isCloudAncestor(candidatePath: "/photos", currentPath: nil),
      "Nil current path is not on chain")
  }

  func testRowIdNamespacingForCloudAndSMB() {
    let serverA = URL(string: "https://serverA.local:8080")!
    let serverB = URL(string: "https://serverB.local:8080")!
    let cloudIdA = SidebarReveal.cloudRowId(serverURL: serverA, path: "/photos")
    let cloudIdB = SidebarReveal.cloudRowId(serverURL: serverB, path: "/photos")

    XCTAssertNotEqual(cloudIdA, cloudIdB, "Cloud row IDs across different servers must not collide")
    XCTAssertEqual(cloudIdA, "https://serverA.local:8080/photos")

    let smbRoot1 = SidebarReveal.smbRowId(host: "nas1", share: "photos", path: "", depth: 0)
    let smbRoot2 = SidebarReveal.smbRowId(host: "nas2", share: "photos", path: "", depth: 0)
    let smbSub1 = SidebarReveal.smbRowId(host: "nas1", share: "photos", path: "/2026", depth: 1)
    let smbSub2 = SidebarReveal.smbRowId(host: "nas2", share: "photos", path: "/2026", depth: 1)

    XCTAssertNotEqual(smbRoot1, smbRoot2)
    XCTAssertNotEqual(
      smbSub1, smbSub2, "SMB subfolder row IDs across different shares must not collide")
    XCTAssertEqual(smbSub1, "smb:nas1/photos/2026")
  }
}
