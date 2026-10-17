// AssetRenameFilenameTests.swift — AssetRef.fullFilename and
// AssetRenameFilename.extensionChanged (#2842).

import CoreImage
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

    // Make a pre-rename edit that is still inside the 750ms debounce window,
    // and kick off an overlapping workflow snapshot operation.
    oldSession.beginEdit(kind: .adjustment, description: "Exposure")
    oldSession.model.exposure = 1.25
    oldSession.culling.stars = 4
    let snapshotTask = Task {
      await oldSession.workflow.saveSnapshot(name: "Before rename", session: oldSession)
    }

    // Pre-rename step from AppShell.commitRename: flush pending edits (joining
    // any in-flight workflow operation) and disable further writes before move.
    await oldSession.flushPendingSidecarWrite()
    await oldSession.setSidecarWritesEnabled(false)
    await snapshotTask.value
    XCTAssertEqual(oldSession.workflow.record?.snapshots.map(\.name), ["Before rename"])
    XCTAssertTrue(fm.fileExists(atPath: oldSidecarURL.path))

    let outcome = try await LocalFileOperations.relocate(
      oldURL, to: tempDir, newBasename: "IMG_0002.dng", mode: .move, collision: .fail)
    let newURL = URL(fileURLWithPath: outcome.primaryPath)
    let newSidecarURL = SidecarPath.sidecarURL(for: newURL)

    XCTAssertFalse(fm.fileExists(atPath: oldSidecarURL.path))
    XCTAssertTrue(fm.fileExists(atPath: newSidecarURL.path))

    // Open the replacement session for the renamed asset and verify it
    // preserves both the pre-rename edits and the undo history.
    let newAsset = AssetRef(url: newURL)
    let newSession = EditSession(asset: newAsset)
    newSession.adoptInFlightRenameEdits(from: oldSession)
    await newSession.loadSidecar()
    XCTAssertEqual(newSession.model.exposure, 1.25, accuracy: 0.001)
    XCTAssertEqual(newSession.culling.stars, 4)
    XCTAssertTrue(newSession.canUndo)
    XCTAssertEqual(newSession.undoHistory.map(\.description), ["Exposure"])

    // Simulate late edits / workflow calls / editor-exit teardown on the old
    // session AND subsequent user edits on the new session.
    oldSession.model.exposure = -2.0
    oldSession.culling.stars = 1
    await oldSession.workflow.saveSnapshot(name: "Stale", session: oldSession)
    await oldSession.workflow.createVariant(name: "StaleVariant", session: oldSession)
    await oldSession.flushPendingSidecarWrite()
    await oldSession.persistDisplayPreviewOnExit()

    newSession.beginEdit(kind: .adjustment, description: "Contrast")
    newSession.model.contrast = 18
    newSession.endEdit()
    await newSession.flushPendingSidecarWrite()
    newSession.renderRequested = true
    await newSession.workflow.createVariant(name: "Branch", session: newSession)
    XCTAssertFalse(newSession.workflow.isBusy)
    await newSession.workflow.selectVariant(
      WorkflowContract.primaryVariantID, session: newSession)
    XCTAssertFalse(newSession.workflow.isBusy)

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
    session.scheduleDisplayPreviewPersist(
      CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 64, height: 64)))

    await session.flushPendingSidecarWrite()
    await session.setSidecarWritesEnabled(false)
    XCTAssertTrue(session.previewPersistence.hasPendingImage)
    // Simulate a gesture completed while the rename I/O is in flight; when the
    // rename fails and writes are re-enabled, this edit must still be persisted.
    session.beginEdit(kind: .adjustment, description: "Exposure")
    session.model.exposure = 0.75
    session.endEdit()
    do {
      _ = try await LocalFileOperations.relocate(
        oldURL, to: tempDir, newBasename: "IMG_0002.dng", mode: .move, collision: .fail)
      XCTFail("Expected collision error")
    } catch {
      await session.setSidecarWritesEnabled(true)
    }

    await session.flushPendingSidecarWrite()
    await session.flushDisplayPreviewPersist()
    let (persistedModel, _) = try XMPParser.parse(data: Data(contentsOf: oldSidecarURL))
    XCTAssertEqual(persistedModel.exposure, 0.75, accuracy: 0.001)
    XCTAssertFalse(session.previewPersistence.hasPendingImage)
  }

  @MainActor
  func testRenameOpenSession_adoptsInFlightEditsMadeDuringRename() async throws {
    let fm = FileManager.default
    let tempDir = fm.temporaryDirectory.appendingPathComponent(
      "rename-session-inflight-\(UUID().uuidString)", isDirectory: true)
    try fm.createDirectory(at: tempDir, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: tempDir) }

    let oldURL = tempDir.appendingPathComponent("IMG_0001.dng")
    try Data("raw-bytes".utf8).write(to: oldURL)
    let oldSidecarURL = SidecarPath.sidecarURL(for: oldURL)

    let oldSession = EditSession(asset: AssetRef(url: oldURL))
    await oldSession.loadSidecar()
    oldSession.model.exposure = 0.5
    await oldSession.flushPendingSidecarWrite()
    // Queue an edit in the suspension gap between flush and disabling writes.
    oldSession.model.contrast = 15
    await oldSession.setSidecarWritesEnabled(false)

    // While relocate is in flight, the user makes another edit in the open editor.
    oldSession.beginEdit(kind: .adjustment, description: "Shadows")
    oldSession.model.shadows = 32
    oldSession.culling.stars = 5
    oldSession.endEdit()

    let outcome = try await LocalFileOperations.relocate(
      oldURL, to: tempDir, newBasename: "IMG_0002.dng", mode: .move, collision: .fail)
    let newURL = URL(fileURLWithPath: outcome.primaryPath)
    let newSidecarURL = SidecarPath.sidecarURL(for: newURL)

    let newSession = EditSession(asset: AssetRef(url: newURL))
    newSession.adoptInFlightRenameEdits(from: oldSession)
    XCTAssertTrue(newSession.canUndo)
    XCTAssertEqual(newSession.lastCommittedTransaction?.description, "Shadows")
    newSession.undo()
    XCTAssertEqual(newSession.model.shadows, 0, accuracy: 0.001)
    newSession.redo()
    XCTAssertEqual(newSession.model.shadows, 32, accuracy: 0.001)
    await newSession.flushPendingSidecarWrite()

    XCTAssertFalse(fm.fileExists(atPath: oldSidecarURL.path))
    let (persistedModel, persistedCulling) = try XMPParser.parse(
      data: Data(contentsOf: newSidecarURL))
    XCTAssertEqual(persistedModel.exposure, 0.5, accuracy: 0.001)
    XCTAssertEqual(persistedModel.contrast, 15, accuracy: 0.001)
    XCTAssertEqual(persistedModel.shadows, 32, accuracy: 0.001)
    XCTAssertEqual(persistedCulling.stars, 5)
  }

  @MainActor
  func testRenameOpenSession_preMoveFlushFailureThrowsAndPreservesUnconfirmedEdits() async throws {
    let fm = FileManager.default
    let tempDir = fm.temporaryDirectory.appendingPathComponent(
      "rename-session-flush-fail-\(UUID().uuidString)", isDirectory: true)
    try fm.createDirectory(at: tempDir, withIntermediateDirectories: true)
    defer {
      try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tempDir.path)
      try? fm.removeItem(at: tempDir)
    }

    let oldURL = tempDir.appendingPathComponent("IMG_0001.dng")
    try Data("raw-bytes".utf8).write(to: oldURL)
    let oldSidecarURL = SidecarPath.sidecarURL(for: oldURL)

    let oldSession = EditSession(asset: AssetRef(url: oldURL))
    await oldSession.loadSidecar()
    // Queue a semantic commit followed immediately by a newer ordinary update
    // before the semantic commit Task finishes.
    oldSession.beginEdit(kind: .adjustment, description: "Exposure")
    oldSession.model.exposure = 1.0
    oldSession.endEdit()
    oldSession.culling.stars = 5
    oldSession.model.exposure = 2.25

    // Let the semantic commit succeed while the newer update sits in debounce;
    // the session must still report an unconfirmed update for the newer edit.
    await oldSession.sidecarUpdateTask?.value
    XCTAssertTrue(oldSession.hasUnconfirmedSidecarUpdate)

    try fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: tempDir.path)

    do {
      try await oldSession.flushPendingSidecarWriteConfirmed()
      XCTFail("Expected pre-rename sidecar flush to throw when directory is read-only")
    } catch {
      XCTAssertNotNil(oldSession.sidecarError)
      XCTAssertTrue(oldSession.hasUnconfirmedSidecarUpdate)
    }

    // Even if a caller disables writes and adopts into a replacement session
    // after a transient flush failure, the unconfirmed edit is preserved.
    await oldSession.setSidecarWritesEnabled(false)
    try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tempDir.path)
    let outcome = try await LocalFileOperations.relocate(
      oldURL, to: tempDir, newBasename: "IMG_0002.dng", mode: .move, collision: .fail)
    let newURL = URL(fileURLWithPath: outcome.primaryPath)
    let newSidecarURL = SidecarPath.sidecarURL(for: newURL)

    let newSession = EditSession(asset: AssetRef(url: newURL))
    newSession.adoptInFlightRenameEdits(from: oldSession)
    try await newSession.flushPendingSidecarWriteConfirmed()

    XCTAssertFalse(fm.fileExists(atPath: oldSidecarURL.path))
    let (persistedModel, persistedCulling) = try XMPParser.parse(
      data: Data(contentsOf: newSidecarURL))
    XCTAssertEqual(persistedModel.exposure, 2.25, accuracy: 0.001)
    XCTAssertEqual(persistedCulling.stars, 5)
  }
}
