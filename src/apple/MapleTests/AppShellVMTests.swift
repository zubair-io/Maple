// AppShellVMTests.swift — unit tests for the pure helpers in
// `Maple/Views/AppShell+VM.swift` (#3402).
//
// Lives in the MapleTests Xcode target (not MapleCore) because `AppShellVM`
// and `AppShell.Mode` are declared in the app target — same host-targeted
// `@testable import Maple_Exposure` arrangement as PreviewViewVMTests.
//
// Focus: a filmstrip tap lands on the surface that hosts the strip (the
// editor's rail keeps `.editing`, Preview's rail keeps `.preview`), and the
// session bookkeeping behind an in-place selection reuses a primed
// `EditSession` rather than replacing it. The SwiftUI wiring that calls
// these (`AppShell.selectFilmstripSibling`, `AppShellCenterColumn`) is
// verified by building, not here.

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

@MainActor
final class AppShellVMTests: XCTestCase {

  // MARK: - filmstripLandingMode (#3402)

  func testEditorFilmstripSelectionStaysInTheEditor() {
    // The bug #3402 fixes: the editor's rail used to route through
    // `openEditor(for:)`, whose tail sets `mode = imageOpenMode`
    // (= `.preview`), so every sibling pick dropped the user out of the
    // editor.
    XCTAssertEqual(
      AppShellVM.filmstripLandingMode(hosting: .editing), .editing,
      "a sibling picked from the editor's rail must stay in the editor")
  }

  func testPreviewFilmstripSelectionStaysInPreview() {
    // Preview's wiring writes `browseVM.selectedID` and never touches
    // `mode`; this pins the contract the shared rail relies on.
    XCTAssertEqual(
      AppShellVM.filmstripLandingMode(hosting: .preview), .preview,
      "a sibling picked from Preview's rail must stay in Preview")
  }

  func testFilmstripSelectionOffAnImageSurfaceLandsOnPreview() {
    // No surface hosts a filmstrip in these modes — a tap that still
    // arrives (a callback firing after the surface was dismissed) opens
    // the photo the same way a grid tap or deep link does.
    XCTAssertEqual(AppShellVM.filmstripLandingMode(hosting: .browse), .preview)
    XCTAssertEqual(AppShellVM.filmstripLandingMode(hosting: .panoramaMerge), .preview)
  }

  // MARK: - ensureSession

  func testEnsureSessionReusesAPrimedSession() {
    let asset = AssetRef.preview(displayName: "IMG_0001.dng")
    let primed = EditSession(asset: asset)
    var sessions: [AssetRef.ID: EditSession] = [asset.id: primed]

    let result = AppShellVM.ensureSession(for: asset, in: &sessions)

    XCTAssertTrue(
      result.session === primed,
      "the grid-primed session must be reused, not replaced")
    XCTAssertFalse(result.created)
    XCTAssertEqual(sessions.count, 1)
  }

  func testEnsureSessionCreatesAndCachesWhenAbsent() {
    let asset = AssetRef.preview(displayName: "IMG_0002.dng")
    var sessions: [AssetRef.ID: EditSession] = [:]

    let result = AppShellVM.ensureSession(for: asset, in: &sessions)

    XCTAssertTrue(result.created, "an unprimed asset owes the caller a sidecar load")
    XCTAssertTrue(
      sessions[asset.id] === result.session,
      "the new session must be cached under the asset id so the grid and a later editor open share it")
    XCTAssertEqual(result.session.asset.id, asset.id)
  }

  func testEnsureSessionLeavesOtherSessionsResident() {
    // Switching siblings must not evict anything itself — eviction is the
    // shell's `pruneInactiveSessions` job, keyed off the selection change.
    let first = AssetRef.preview(displayName: "IMG_0003.dng")
    let second = AssetRef.preview(displayName: "IMG_0004.dng")
    let firstSession = EditSession(asset: first)
    var sessions: [AssetRef.ID: EditSession] = [first.id: firstSession]

    _ = AppShellVM.ensureSession(for: second, in: &sessions)

    XCTAssertTrue(sessions[first.id] === firstSession)
    XCTAssertNotNil(sessions[second.id])
    XCTAssertEqual(sessions.count, 2)
  }

  // MARK: - Search Preview sibling splice (#3551)

  private func cloudRef(path: String) -> AssetRef {
    let name = (path as NSString).lastPathComponent
    return AssetRef(
      displayName: name, hintExtension: "dng", stableID: "fs:\(path)",
      catalog: CatalogRef(
        serverID: URL(string: "https://cloud.example")!, folderID: "f1", absPath: path, address: nil),
      bytesProvider: { Data() })
  }

  func testSplicingTappedAssetReplacesItsFolderEntryByPath() {
    let siblings = [cloudRef(path: "/lib/a.dng"), cloudRef(path: "/lib/b.dng"), cloudRef(path: "/lib/c.dng")]
    let tapped = cloudRef(path: "/lib/b.dng")  // fresh id, same catalog path

    let spliced = AppShellVM.splicingTappedAsset(tapped, into: siblings)

    XCTAssertEqual(spliced.count, 3)
    XCTAssertEqual(spliced[1].id, tapped.id, "the tapped ref itself sits at its folder position")
    XCTAssertEqual(spliced[0].id, siblings[0].id)
    XCTAssertEqual(spliced[2].id, siblings[2].id)
  }

  func testSplicingTappedAssetFallsBackToSingleAssetWhenAbsent() {
    let siblings = [cloudRef(path: "/lib/a.dng")]
    let tapped = cloudRef(path: "/elsewhere/z.dng")

    let spliced = AppShellVM.splicingTappedAsset(tapped, into: siblings)

    XCTAssertEqual(spliced.map(\.id), [tapped.id])
  }
}
