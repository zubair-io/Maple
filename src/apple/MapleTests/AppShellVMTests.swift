// AppShellVMTests.swift — unit tests for the pure helpers in
// `Maple/Views/AppShell+VM.swift` (#3402).
//
// Lives in the MapleTests Xcode target (not MapleCore) because `AppShellVM`
// and `AppShell.Mode` are declared in the app target — same host-targeted
// `@testable import Maple` arrangement as PreviewViewVMTests.
//
// Focus: a filmstrip tap lands on the surface that hosts the strip (the
// editor's rail keeps `.editing`, Preview's rail keeps `.preview`), and the
// session bookkeeping behind an in-place selection reuses a primed
// `EditSession` rather than replacing it. The SwiftUI wiring that calls
// these (`AppShell.selectFilmstripSibling`, `AppShellCenterColumn`) is
// verified by building, not here.

import CoreImage
import Foundation
import MapleCore
import XCTest

@testable import Maple

private actor RecordingPreviewSink: DisplayPreviewSink {
  private(set) var writes: [Data] = []
  func write(_ bytes: Data) async { writes.append(bytes) }
  func count() -> Int { writes.count }
  func last() -> Data? { writes.last }
}

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

    let result = AppShellVM.ensureSession(for: asset, in: &sessions, remoteStore: { nil })

    XCTAssertTrue(
      result.session === primed,
      "the grid-primed session must be reused, not replaced")
    XCTAssertFalse(result.created)
    XCTAssertEqual(sessions.count, 1)
  }

  func testEnsureSessionCreatesAndCachesWhenAbsent() {
    let asset = AssetRef.preview(displayName: "IMG_0002.dng")
    var sessions: [AssetRef.ID: EditSession] = [:]

    let result = AppShellVM.ensureSession(for: asset, in: &sessions, remoteStore: { nil })

    XCTAssertTrue(result.created, "an unprimed asset owes the caller a sidecar load")
    XCTAssertTrue(
      sessions[asset.id] === result.session,
      "the new session must be cached under the asset id so the grid and a later editor open share it"
    )
    XCTAssertEqual(result.session.asset.id, asset.id)
  }

  func testEnsureSessionLeavesOtherSessionsResident() {
    // Switching siblings must not evict anything itself — eviction is the
    // shell's `pruneInactiveSessions` job, keyed off the selection change.
    let first = AssetRef.preview(displayName: "IMG_0003.dng")
    let second = AssetRef.preview(displayName: "IMG_0004.dng")
    let firstSession = EditSession(asset: first)
    var sessions: [AssetRef.ID: EditSession] = [first.id: firstSession]

    _ = AppShellVM.ensureSession(for: second, in: &sessions, remoteStore: { nil })

    XCTAssertTrue(sessions[first.id] === firstSession)
    XCTAssertNotNil(sessions[second.id])
    XCTAssertEqual(sessions.count, 2)
  }

  // MARK: - ensureSession wires the source-aware store (#4712)

  /// The bug: filmstrip sibling navigation and `openEditor(for:)` built
  /// `EditSession(asset:downloadProgress:)` with no remote store, so a
  /// Cloud / PhotoKit / SMB sibling opened on defaults and every edit to
  /// it was session-local — gone on the next selection change. The
  /// helper must hand the caller's store to the session it creates, and
  /// an edit must reach that store.
  func testEnsureSessionRoutesEditsOnANewSessionThroughTheRemoteStore() async throws {
    // A real XMP store on a temp path stands in for the remote store: the
    // sidecar is the contract, so the proof is the `.xmp` on disk, not a
    // fake's bookkeeping.
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("AppShellVMTests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    let rawURL = dir.appendingPathComponent("b.dng")
    let asset = cloudRef(path: "/lib/b.dng")
    var sessions: [AssetRef.ID: EditSession] = [:]

    let result = AppShellVM.ensureSession(
      for: asset, in: &sessions, remoteStore: { XMPSidecarStore(rawURL: rawURL) })
    var edited = result.session.model
    edited.exposure = 1.5
    result.session.model = edited
    for _ in 0..<5 { await Task.yield() }
    await result.session.flushPendingSidecarWrite()

    let (persisted, _) = try await XMPSidecarStore(rawURL: rawURL).load()
    XCTAssertEqual(
      persisted.exposure, 1.5,
      "an edit on a sourced sibling must round-trip through its remote sidecar store")
  }

  func testEnsureSessionDoesNotResolveAStoreForAPrimedSession() {
    let asset = cloudRef(path: "/lib/c.dng")
    let primed = EditSession(asset: asset)
    var sessions: [AssetRef.ID: EditSession] = [asset.id: primed]

    let result = AppShellVM.ensureSession(
      for: asset, in: &sessions,
      remoteStore: {
        XCTFail("a primed session already owns its store — resolving another is wasted work")
        return nil
      },
      remotePreviewSink: {
        XCTFail("a primed session already owns its preview sink — resolving another is wasted work")
        return nil
      })

    XCTAssertTrue(result.session === primed)
  }

  // MARK: - Cloud session preview sink wiring (#4846)

  /// #4846: grid-primed cloud sessions (`browseSession(for:)`) and sibling
  /// sessions (`ensureSession`) must attach a `CloudDisplayPreviewSink`
  /// alongside `CloudSidecarStore` so edits on cloud assets also upload the
  /// rendered AVIF preview to `PUT /api/preview?path=…` on exit.
  func testBrowseSessionWiresCloudDisplayPreviewSinkForCloudRefs() throws {
    let shell = AppShell()
    let catalogAsset = cloudRef(path: "/lib/2026/IMG_0042.DNG")
    let catalogSession = shell.browseSession(for: catalogAsset)
    let catalogSink = try XCTUnwrap(
      catalogSession.displayPreviewSink as? CloudDisplayPreviewSink,
      "a catalog-backed cloud browse ref must receive a CloudDisplayPreviewSink")
    XCTAssertEqual(catalogSink.server, URL(string: "https://cloud.example")!)
    XCTAssertEqual(catalogSink.assetPath, "/lib/2026/IMG_0042.DNG")

    let provenanceServer = URL(string: "https://timeline.example")!
    let timelineAsset = AssetRef(
      displayName: "IMG_0099.DNG", hintExtension: "dng", stableID: "fs:/photos/IMG_0099.DNG",
      thumbnailProvenance: .cloud(server: provenanceServer),
      bytesProvider: { Data() })
    let timelineSession = shell.browseSession(for: timelineAsset)
    let timelineSink = try XCTUnwrap(
      timelineSession.displayPreviewSink as? CloudDisplayPreviewSink,
      "a .cloud(server:)-provenance ref must receive a CloudDisplayPreviewSink")
    XCTAssertEqual(timelineSink.server, provenanceServer)
    XCTAssertEqual(timelineSink.assetPath, "/photos/IMG_0099.DNG")

    let photoKitAsset = AssetRef(
      displayName: "PK.HEIC", hintExtension: "heic", stableID: "L0/001",
      thumbnailProvenance: .photoKit,
      bytesProvider: { Data() })
    let photoKitSession = shell.browseSession(for: photoKitAsset)
    XCTAssertNil(
      photoKitSession.displayPreviewSink,
      "PhotoKit refs must never receive a CloudDisplayPreviewSink")
  }

  /// #4846: a cloud-provenance ref primed through `AppShellVM.ensureSession`
  /// exposes a non-nil `displayPreviewSink` and `persistDisplayPreviewOnExit()`
  /// reaches it alongside the sidecar store write.
  func testEnsureSessionWiresPreviewSinkAndPersistOnExitReachesIt() async throws {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("AppShellVMTests-preview-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    let rawURL = dir.appendingPathComponent("cloud.dng")
    let sink = RecordingPreviewSink()
    let server = URL(string: "https://cloud.example")!
    let asset = AssetRef(
      displayName: "cloud.dng", hintExtension: "dng", stableID: "fs:/lib/cloud.dng",
      thumbnailProvenance: .cloud(server: server),
      catalog: CatalogRef(
        serverID: server, folderID: "f1", absPath: "/lib/cloud.dng", address: nil),
      bytesProvider: { Data() })
    var sessions: [AssetRef.ID: EditSession] = [:]

    let result = AppShellVM.ensureSession(
      for: asset,
      in: &sessions,
      remoteStore: { XMPSidecarStore(rawURL: rawURL) },
      remotePreviewSink: { sink })

    XCTAssertNotNil(result.session.displayPreviewSink)
    var edited = result.session.model
    edited.exposure = 0.75
    result.session.model = edited
    let frame = CIImage(color: .init(red: 0.3, green: 0.5, blue: 0.7, alpha: 1))
      .cropped(to: CGRect(x: 0, y: 0, width: 1_280, height: 960))
    result.session.scheduleDisplayPreviewPersist(frame)

    await result.session.persistDisplayPreviewOnExit()

    let (persisted, _) = try await XMPSidecarStore(rawURL: rawURL).load()
    XCTAssertEqual(persisted.exposure, 0.75)
    let sinkWrites = await sink.count()
    XCTAssertEqual(
      sinkWrites, 1,
      "persistDisplayPreviewOnExit() on a session primed via ensureSession must reach its displayPreviewSink"
    )
    let lastBytes = await sink.last()
    let bytes = try XCTUnwrap(lastBytes)
    XCTAssertEqual(bytes[4..<8], Data("ftyp".utf8))
  }

  func testCloudServerAndAssetPathPrecedence() {
    let explicitServer = URL(string: "https://explicit.example")!
    let catalogServer = URL(string: "https://catalog.example")!
    let ambientServer = URL(string: "https://ambient.example")!

    let provenanceRef = AssetRef(
      displayName: "a.dng", hintExtension: "dng", stableID: "fs:/lib/a.dng",
      thumbnailProvenance: .cloud(server: explicitServer),
      catalog: CatalogRef(
        serverID: catalogServer, folderID: "f1", absPath: "/lib/a.dng", address: nil),
      bytesProvider: { Data() })
    XCTAssertEqual(
      AppShellVM.cloudServer(for: provenanceRef, ambientServer: { ambientServer }),
      explicitServer,
      "explicit .cloud(server:) provenance takes precedence over catalog and ambient")

    let catalogRef = cloudRef(path: "/lib/b.dng")
    XCTAssertEqual(
      AppShellVM.cloudServer(for: catalogRef, ambientServer: { ambientServer }),
      URL(string: "https://cloud.example")!,
      "catalog.serverID takes precedence over ambient selection")
    XCTAssertEqual(AppShellVM.cloudAssetPath(for: catalogRef), "/lib/b.dng")

    let renamed = AssetRef(
      displayName: "b-renamed.dng", hintExtension: "dng", stableID: "fs:/lib/b.dng",
      catalog: CatalogRef(
        serverID: URL(string: "https://cloud.example")!, folderID: "f1",
        absPath: "/lib/b-renamed.dng", address: nil),
      bytesProvider: { Data() })
    XCTAssertEqual(
      AppShellVM.cloudAssetPath(for: renamed), "/lib/b-renamed.dng",
      "renamed cloud ref uses updated catalog.absPath even while stableID stays pinned")

    let ambientOnlyRef = AssetRef(
      displayName: "c.dng", hintExtension: "dng", stableID: "fs:/lib/c.dng",
      bytesProvider: { Data() })
    XCTAssertEqual(
      AppShellVM.cloudServer(for: ambientOnlyRef, ambientServer: { ambientServer }),
      ambientServer)
    XCTAssertEqual(AppShellVM.cloudAssetPath(for: ambientOnlyRef), "/lib/c.dng")
  }

  // MARK: - Search Preview sibling splice (#3551)

  private func cloudRef(path: String) -> AssetRef {
    let name = (path as NSString).lastPathComponent
    return AssetRef(
      displayName: name, hintExtension: "dng", stableID: "fs:\(path)",
      catalog: CatalogRef(
        serverID: URL(string: "https://cloud.example")!, folderID: "f1", absPath: path, address: nil
      ),
      bytesProvider: { Data() })
  }

  func testSplicingTappedAssetReplacesItsFolderEntryByPath() {
    let siblings = [
      cloudRef(path: "/lib/a.dng"), cloudRef(path: "/lib/b.dng"), cloudRef(path: "/lib/c.dng"),
    ]
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
