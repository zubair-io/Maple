import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class RemovalSessionTests: XCTestCase {
  private func stage() throws -> EditSession {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let fixture = try XCTUnwrap(
      Bundle.module.url(
        forResource: "source", withExtension: "dng",
        subdirectory: "removal/calibration"))
    let raw = directory.appendingPathComponent("photo.dng")
    try FileManager.default.copyItem(at: fixture, to: raw)
    return EditSession(asset: AssetRef(url: raw))
  }

  func testPaintUndoRedoProtectionAndCancelNeverPublishTemporaryPixels() async throws {
    let session = try stage()
    let removal = EditorState(session: session).removal
    await removal.open()
    XCTAssertEqual(removal.phase, .ready, removal.message)
    let raw = try XCTUnwrap(session.asset.primaryURL)
    let original = try Data(contentsOf: raw)
    let sidecar = try XCTUnwrap(session.asset.sidecarURL)
    let before = try? Data(contentsOf: sidecar)
    removal.radius = 0.1
    await removal.paint([[0.4, 0.5]], cropInputSize: [16, 8])
    let first = removal.selection
    XCTAssertFalse(first.isEmpty)
    XCTAssertTrue(removal.canUndoSelection)
    await removal.paint([[0.8, 0.5]], cropInputSize: [16, 8])
    XCTAssertNotEqual(removal.selection, first)
    let selected = removal.selection
    await removal.paint([[Double.nan, 0.5]], cropInputSize: [16, 8])
    XCTAssertFalse(removal.message.isEmpty)
    XCTAssertEqual(removal.selection, selected, "Rejected input preserves the current mask")
    await removal.undoSelection()
    XCTAssertEqual(removal.selection, first)
    XCTAssertTrue(removal.message.isEmpty)
    XCTAssertTrue(removal.canRedoSelection)
    removal.protection = Data([0])
    await removal.redoSelection()
    XCTAssertFalse(removal.message.isEmpty)
    XCTAssertEqual(removal.selection, first)
    XCTAssertTrue(removal.canRedoSelection, "Failed replay retains redo intent")
    removal.protection = Data()
    await removal.redoSelection()
    XCTAssertTrue(removal.message.isEmpty)
    let both = removal.selection
    XCTAssertNotEqual(both, first)
    removal.protectSelection()
    XCTAssertEqual(removal.protection, both)
    XCTAssertTrue(removal.selection.isEmpty)
    await removal.paint([[0.4, 0.5]], cropInputSize: [16, 8])
    XCTAssertTrue(removal.selection.isEmpty, "Protected intent cannot be removed")
    removal.clearProtection()
    await removal.paint([[0.4, 0.5]], cropInputSize: [16, 8])
    XCTAssertEqual(removal.selection, first)
    removal.cancel()
    XCTAssertEqual(removal.phase, .ready)
    XCTAssertNil(removal.preview)
    XCTAssertEqual(removal.selection, first, "Cancel retains the selection for correction")
    XCTAssertEqual(try? Data(contentsOf: sidecar), before)
    XCTAssertEqual(try Data(contentsOf: raw), original)
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath:
          raw.deletingLastPathComponent().appendingPathComponent(".maple/inpaint").path))
    removal.close()
    await session.releaseTransientMemory()
  }

  func testCroppedRotatedPaintingAndOverlayAgreeInSourceCoordinates() async throws {
    let session = try stage()
    session.model.crop = Crop(top: 0, left: 0.25, bottom: 1, right: 0.75, angle: 90)
    let removal = RemovalSession(session: session)
    await removal.open()
    XCTAssertEqual(removal.phase, .ready, removal.message)
    removal.radius = 0.1
    await removal.paint([[0.5, 0.25]], cropInputSize: [16, 8])
    let mask = try RemovalBridge.decodeMask(removal.selection)
    XCTAssertTrue(mask.x <= 6 && mask.x + mask.width > 6)
    XCTAssertTrue(mask.y <= 4 && mask.y + mask.height > 4)
    let overlay = try await removal.overlay(cropInputSize: [16, 8], aspect: 1)
    XCTAssertEqual(overlay.width, 256)
    XCTAssertEqual(overlay.height, 256)
    let index = (64 * 256 + 128) * 4 + 3
    XCTAssertEqual(overlay.selection[index], 255)
    XCTAssertTrue(overlay.protection.allSatisfy { $0 == 0 })
    XCTAssertTrue(overlay.labels.isEmpty)
    removal.close()
    await session.releaseTransientMemory()
  }

  func testExplicitPaintRefinementRetainsSmartMaskAndResetsWithTheTool() async throws {
    let session = try stage()
    let removal = RemovalSession(session: session)
    await removal.open()
    removal.refineWithPaint()
    XCTAssertEqual(removal.mode, .paint, "No Smart result is available")
    removal.radius = 0.1
    await removal.paint([[0.4, 0.5]], cropInputSize: [16, 8])
    let protection = removal.selection
    removal.protectSelection()
    await removal.setMode(.smart)
    removal.refineWithPaint()
    XCTAssertEqual(removal.mode, .smart, "An empty result cannot be frozen")
    // This fixture-free control supplies a real shared-rasterized native mask;
    // the photographic test exercises the actual model and its rejected stroke.
    let base = try await removal.engine.paint(
      [RemovalStroke(points: [[0.8, 0.5]], radius: 0.1, subtract: false)],
      context: XCTUnwrap(removal.context))
    removal.selection = base
    removal.phase = .selecting
    removal.refineWithPaint()
    XCTAssertEqual(removal.mode, .smart, "An in-flight result cannot be frozen")
    removal.phase = .ready
    removal.refineWithPaint()
    XCTAssertEqual(removal.mode, .paint)
    XCTAssertEqual(removal.selection, base)
    XCTAssertEqual(removal.protection, protection)
    XCTAssertFalse(removal.canUndoSelection)
    removal.subtract = true
    await removal.paint([[0.8, 0.5]], cropInputSize: [16, 8])
    XCTAssertTrue(removal.selection.isEmpty)
    await removal.undoSelection()
    XCTAssertEqual(removal.selection, base)
    await removal.redoSelection()
    XCTAssertTrue(removal.selection.isEmpty)
    removal.clearSelection()
    XCTAssertTrue(removal.paintedSelectionBase.isEmpty)
    removal.subtract = false
    await removal.paint([[0.8, 0.5]], cropInputSize: [16, 8])
    await removal.undoSelection()
    XCTAssertTrue(removal.selection.isEmpty, "Clear cannot resurrect the frozen result")
    removal.close()
    XCTAssertTrue(removal.paintedSelectionBase.isEmpty)
    XCTAssertTrue(session.undoHistory.isEmpty)
    let raw = try XCTUnwrap(session.asset.primaryURL)
    XCTAssertFalse(FileManager.default.fileExists(atPath: SidecarPath.sidecarURL(for: raw).path))
    await session.releaseTransientMemory()
  }

  func testSurroundBreaksStrokesInsteadOfPaintingAConnectingLine() async throws {
    let session = try stage()
    let removal = RemovalSession(session: session)
    await removal.open()
    removal.radius = 0.1
    await removal.paint([[0.2, 0.5], [1.1, 0.5], [0.8, 0.5]], cropInputSize: [16, 8])
    XCTAssertEqual(removal.strokes.count, 2)
    let mask = try RemovalBridge.decodeMask(removal.selection)
    let centre = (4 - Int(mask.y)) * Int(mask.width) + 8 - Int(mask.x)
    XCTAssertEqual(mask.pixels[centre], 0, "A surround sample cannot join disconnected strokes")
    await removal.undoSelection()
    XCTAssertTrue(removal.selection.isEmpty, "Undo removes the entire pointer gesture")
    await removal.redoSelection()
    XCTAssertEqual(removal.strokes.count, 2)
    removal.close()
    await session.releaseTransientMemory()
  }

  func testLeavingToolDiscardsTransientWorkAndReopeningIsFresh() async throws {
    let session = try stage()
    let editor = EditorState(session: session)
    editor.arm(tool: .remove)
    await editor.removal.open()
    editor.removal.radius = 0.1
    await editor.removal.paint([[0.4, 0.5]], cropInputSize: [16, 8])
    editor.arm(tool: .exposure)
    XCTAssertEqual(editor.removal.phase, .closed)
    XCTAssertFalse(editor.removal.active)
    XCTAssertTrue(editor.removal.selection.isEmpty)
    editor.arm(tool: .remove)
    await editor.removal.open()
    XCTAssertEqual(editor.removal.phase, .ready)
    XCTAssertTrue(editor.removal.selection.isEmpty)
    editor.removal.close()
    await session.releaseTransientMemory()
  }

  #if os(macOS)
    func testPeopleListChoicesNeedModelsAndClearWithoutPublishing() async throws {
      let session = try stage()
      let raw = try XCTUnwrap(session.asset.primaryURL)
      let original = try Data(contentsOf: raw)
      let removal = RemovalSession(
        session: session,
        modelStore: MacRemovalModelStore(
          root: raw.deletingLastPathComponent().appendingPathComponent("models")))
      await removal.open()
      await removal.setMode(.people)
      removal.people = [
        RemovalSession.Person(
          id: 1, detection: NativeRemovalDetection(class: 0, bounds: [0, 0, 4, 8], score: 0.9),
          keep: true)
      ]
      removal.keepPerson(1)
      XCTAssertFalse(removal.people[0].keep)
      XCTAssertTrue(removal.personChoicesNeedApply)
      XCTAssertTrue(removal.message.contains("Click Remove"))
      XCTAssertFalse(removal.canRemove)
      await removal.remove()
      XCTAssertEqual(removal.phase, .ready)
      XCTAssertFalse(removal.message.contains("Apply person choices"))
      XCTAssertNil(removal.preview)
      XCTAssertTrue(removal.proposals.isEmpty)
      removal.keepPerson(99)
      XCTAssertFalse(removal.people[0].keep, "Unknown labels do not change choices")
      removal.keepPerson(1)
      XCTAssertTrue(removal.people[0].keep)
      XCTAssertTrue(removal.message.contains("No people selected"))
      XCTAssertFalse(removal.canRemove)
      removal.clearProtection()
      XCTAssertTrue(removal.personChoicesNeedApply)
      removal.clearSelectedPeople()
      XCTAssertTrue(removal.people.allSatisfy(\.keep))
      XCTAssertFalse(removal.canRemove)
      await removal.remove()
      XCTAssertTrue(removal.message.contains("No people selected"))
      removal.close()
      XCTAssertFalse(removal.personChoicesNeedApply)
      XCTAssertEqual(removal.mode, .paint)
      await removal.open()
      XCTAssertEqual(removal.mode, .paint)
      XCTAssertTrue(removal.people.isEmpty, "Reopening the AI editor must not auto-run People")
      removal.close()
      XCTAssertEqual(try Data(contentsOf: raw), original)
      XCTAssertFalse(FileManager.default.fileExists(atPath: SidecarPath.sidecarURL(for: raw).path))
      await session.releaseTransientMemory()
    }

    func testRemoveWithoutSelectionOrPreparedContextReportsTheMissingStep() async throws {
      let session = try stage()
      let removal = RemovalSession(session: session)
      await removal.open()
      await removal.remove()
      XCTAssertEqual(removal.phase, .ready)
      XCTAssertTrue(removal.message.contains("Paint"))
      await removal.setMode(.people)
      await removal.remove()
      XCTAssertTrue(removal.message.contains("No people selected"))
      removal.close()
      await session.releaseTransientMemory()
    }

    func testImportCannotReopenAClosedOrFailedPhoto() async throws {
      let session = try stage()
      let raw = try XCTUnwrap(session.asset.primaryURL)
      let folder = raw.deletingLastPathComponent()
      let destination = folder.appendingPathComponent("models")
      let removal = RemovalSession(
        session: session, modelStore: MacRemovalModelStore(root: destination))
      await removal.chooseModelFolder(folder)
      XCTAssertEqual(removal.phase, .closed)
      XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
      try Data([0]).write(to: raw)
      await removal.open()
      XCTAssertEqual(removal.phase, .failed)
      await removal.chooseModelFolder(folder)
      XCTAssertEqual(removal.phase, .failed)
      XCTAssertFalse(removal.canRemove)
      removal.close()
      await session.releaseTransientMemory()
    }

    func testIncompleteImportPreservesSelectionAndCannotEnableRemove() async throws {
      let session = try stage()
      let raw = try XCTUnwrap(session.asset.primaryURL)
      let folder = raw.deletingLastPathComponent()
      let original = try Data(contentsOf: raw)
      let removal = RemovalSession(
        session: session,
        modelStore: MacRemovalModelStore(root: folder.appendingPathComponent("models")))
      await removal.open()
      removal.radius = 0.1
      await removal.paint([[0.4, 0.5]], cropInputSize: [16, 8])
      let selected = removal.selection
      await removal.chooseModelFolder(folder)
      XCTAssertEqual(removal.phase, .ready)
      XCTAssertFalse(removal.message.isEmpty)
      XCTAssertEqual(removal.selection, selected)
      XCTAssertNil(removal.modelFolderName)
      XCTAssertFalse(removal.canRemove)
      XCTAssertEqual(try Data(contentsOf: raw), original)
      XCTAssertFalse(FileManager.default.fileExists(atPath: SidecarPath.sidecarURL(for: raw).path))
      removal.close()
      await session.releaseTransientMemory()
    }
  #endif
}
