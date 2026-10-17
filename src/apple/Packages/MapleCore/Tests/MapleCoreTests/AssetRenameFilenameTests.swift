// AssetRenameFilenameTests.swift — AssetRef.fullFilename and
// AssetRenameFilename.extensionChanged (#2842).

import XCTest

@testable import MapleCore

final class AssetRenameFilenameTests: XCTestCase {
  private func localAsset(_ path: String) -> AssetRef {
    AssetRef(url: URL(fileURLWithPath: path))
  }

  private func bytesBackedAsset(_ name: String) -> AssetRef {
    AssetRef(
      displayName: name, hintExtension: "dng",
      stableID: "phasset-\(name)",
      bytesProvider: { Data() })
  }

  // MARK: - fullFilename

  func testLocalAsset_UsesURLLastPathComponent() {
    XCTAssertEqual(localAsset("/photos/2026/IMG_0001.dng").fullFilename, "IMG_0001.dng")
  }

  func testBytesBackedAsset_UsesDisplayNameVerbatim() {
    // Bytes-backed refs (SMB/Cloud/PhotoKit) already carry the full
    // filename in displayName, unlike primaryURL-backed refs where
    // displayName is stripped of its extension.
    XCTAssertEqual(bytesBackedAsset("IMG_0002.dng").fullFilename, "IMG_0002.dng")
  }

  func testLocalAsset_NestedDirectory_OnlyLastComponent() {
    XCTAssertEqual(localAsset("/a/b/c/photo.cr3").fullFilename, "photo.cr3")
  }

  // MARK: - extensionChanged(from:to:)

  func testSameExtension_ReportsNoChange() {
    XCTAssertFalse(AssetRenameFilename.extensionChanged(from: "a.dng", to: "b.dng"))
  }

  func testDifferentExtension_ReportsChange() {
    XCTAssertTrue(AssetRenameFilename.extensionChanged(from: "a.dng", to: "a.jpg"))
  }

  func testExtensionCaseDifference_IsNotAChange() {
    XCTAssertFalse(AssetRenameFilename.extensionChanged(from: "a.DNG", to: "a.dng"))
  }

  func testOriginalHasNoExtension_NeverReportsChange() {
    XCTAssertFalse(AssetRenameFilename.extensionChanged(from: "README", to: "README.md"))
  }

  func testNewFilenameDropsExtension_ReportsChange() {
    XCTAssertTrue(AssetRenameFilename.extensionChanged(from: "a.dng", to: "a"))
  }

  func testStemOnlyChange_NoExtensionChange() {
    XCTAssertFalse(AssetRenameFilename.extensionChanged(from: "sunset.jpg", to: "sunset-edit.jpg"))
  }

  // MARK: - Open EditSession rename sidecar handover (#4711)

  @MainActor
  func testRenameOpenSession_flushesPendingEdit_movesSidecar_andFurtherEditsWriteOnlyToNewSidecar()
    async throws
  {
    let fm = FileManager.default
    let tempDir = fm.temporaryDirectory.appendingPathComponent(
      "rename-session-\(UUID().uuidString)", isDirectory: true)
    try fm.createDirectory(at: tempDir, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: tempDir) }

    let oldURL = tempDir.appendingPathComponent("IMG_0001.dng")
    try Data("raw-bytes".utf8).write(to: oldURL)
    let oldSidecarURL = SidecarPath.sidecarURL(for: oldURL)

    let oldAsset = AssetRef(url: oldURL)
    let oldSession = EditSession(asset: oldAsset)
    await oldSession.loadSidecar()

    // Make a pre-rename edit that is still inside the 750ms debounce window.
    oldSession.beginEdit(kind: .adjustment, description: "Exposure")
    oldSession.model.exposure = 1.25
    oldSession.culling.stars = 4

    // Pre-rename step from AppShell.commitRename: flush pending edits and
    // disable further writes on the departing session before moving the file.
    await oldSession.flushPendingSidecarWrite()
    await oldSession.setSidecarWritesEnabled(false)
    XCTAssertTrue(fm.fileExists(atPath: oldSidecarURL.path))

    let outcome = try await LocalFileOperations.relocate(
      oldURL, to: tempDir, newBasename: "IMG_0002.dng", mode: .move, collision: .fail)
    let newURL = URL(fileURLWithPath: outcome.primaryPath)
    let newSidecarURL = SidecarPath.sidecarURL(for: newURL)

    XCTAssertFalse(fm.fileExists(atPath: oldSidecarURL.path))
    XCTAssertTrue(fm.fileExists(atPath: newSidecarURL.path))

    // Open the replacement session for the renamed asset and verify it
    // hydrates the pre-rename edits from the relocated sidecar.
    let newAsset = AssetRef(url: newURL)
    let newSession = EditSession(asset: newAsset)
    await newSession.loadSidecar()
    XCTAssertEqual(newSession.model.exposure, 1.25, accuracy: 0.001)
    XCTAssertEqual(newSession.culling.stars, 4)

    // Simulate late edits / editor-exit teardown on the old session AND
    // subsequent user edits on the new session.
    oldSession.model.exposure = -2.0
    oldSession.culling.stars = 1
    await oldSession.flushPendingSidecarWrite()
    await oldSession.persistDisplayPreviewOnExit()

    newSession.beginEdit(kind: .adjustment, description: "Contrast")
    newSession.model.contrast = 18
    newSession.endEdit()
    await newSession.flushPendingSidecarWrite()

    XCTAssertFalse(
      fm.fileExists(atPath: oldSidecarURL.path),
      "departing session must never resurrect the old sidecar after rename")
    let (persistedModel, persistedCulling) = try XMPParser.parse(
      data: Data(contentsOf: newSidecarURL))
    XCTAssertEqual(persistedModel.exposure, 1.25, accuracy: 0.001)
    XCTAssertEqual(persistedModel.contrast, 18, accuracy: 0.001)
    XCTAssertEqual(persistedCulling.stars, 4)
  }

  @MainActor
  func testRenameOpenSession_failedRenameReenablesSidecarWrites() async throws {
    let fm = FileManager.default
    let tempDir = fm.temporaryDirectory.appendingPathComponent(
      "rename-session-fail-\(UUID().uuidString)", isDirectory: true)
    try fm.createDirectory(at: tempDir, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: tempDir) }

    let oldURL = tempDir.appendingPathComponent("IMG_0001.dng")
    let collidingURL = tempDir.appendingPathComponent("IMG_0002.dng")
    try Data("raw-1".utf8).write(to: oldURL)
    try Data("raw-2".utf8).write(to: collidingURL)
    let oldSidecarURL = SidecarPath.sidecarURL(for: oldURL)

    let session = EditSession(asset: AssetRef(url: oldURL))
    await session.loadSidecar()

    await session.flushPendingSidecarWrite()
    await session.setSidecarWritesEnabled(false)
    do {
      _ = try await LocalFileOperations.relocate(
        oldURL, to: tempDir, newBasename: "IMG_0002.dng", mode: .move, collision: .fail)
      XCTFail("Expected collision error")
    } catch {
      await session.setSidecarWritesEnabled(true)
    }

    session.model.exposure = 0.75
    await session.flushPendingSidecarWrite()
    let (persistedModel, _) = try XMPParser.parse(data: Data(contentsOf: oldSidecarURL))
    XCTAssertEqual(persistedModel.exposure, 0.75, accuracy: 0.001)
  }
}
