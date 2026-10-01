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
    await removal.undoSelection()
    XCTAssertEqual(removal.selection, first)
    XCTAssertTrue(removal.canRedoSelection)
    await removal.redoSelection()
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
}
