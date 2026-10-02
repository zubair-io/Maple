import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class RemovalPersonRefinementTests: XCTestCase {
  private func circle(_ x: Double, _ y: Double, radius: Double = 0.07) throws -> Data {
    try RemovalBridge.selection(
      width: 16, height: 8,
      request:
        "{\"schema\":1,\"strokes\":[{\"points\":[[\(x),\(y)]],\"radius\":\(radius),\"subtract\":false}]}"
    )
  }

  func testPersonRefinementKeepsIndependentWindowsAndProtectedPixelsWithUndoRedo() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixture = try XCTUnwrap(
      Bundle.module.url(
        forResource: "source", withExtension: "dng", subdirectory: "removal/calibration"))
    let raw = directory.appendingPathComponent("photo.dng")
    try FileManager.default.copyItem(at: fixture, to: raw)
    let original = try Data(contentsOf: raw)
    let session = EditSession(asset: AssetRef(url: raw))
    let removal = RemovalSession(session: session)
    await removal.open()
    XCTAssertEqual(removal.phase, .ready, removal.message)
    removal.setMode(.people)
    let left = try circle(3.5 / 16, 3.5 / 8)
    let right = try circle(12.5 / 16, 3.5 / 8)
    removal.personMasks = [left, right]
    removal.selection = try RemovalBridge.combineMasks(left, right)
    removal.resetPersonRefinement([
      RemovalPersonSelection(id: 1, mask: left), RemovalPersonSelection(id: 2, mask: right),
    ])
    removal.protection = try circle(7.5 / 16, 3.5 / 8)
    let initial = removal.selection
    removal.refinePerson(1)
    removal.radius = 0.07
    await removal.paint([[3.5 / 16, 6.5 / 8]], cropInputSize: [16, 8])
    let added = removal.selection
    XCTAssertNotEqual(added, initial)
    XCTAssertEqual(removal.personMasks.count, 2)
    XCTAssertEqual(
      removal.personMasks[1], right, "The other person's native window stays unchanged")
    await removal.undoSelection()
    XCTAssertEqual(removal.selection, initial)
    await removal.redoSelection()
    XCTAssertEqual(removal.selection, added)
    await removal.paint([[7.5 / 16, 3.5 / 8]], cropInputSize: [16, 8])
    XCTAssertTrue(
      try RemovalBridge.combineMasks(removal.selection, removal.protection, subtract: true)
        == removal.selection)
    removal.refinePerson(2)
    removal.subtract = true
    await removal.paint([[12.5 / 16, 3.5 / 8]], cropInputSize: [16, 8])
    XCTAssertEqual(removal.personMasks.count, 1)
    await removal.undoSelection()
    XCTAssertEqual(
      removal.personMasks.count, 2, "Undo targets the correct person after switching refinement")
    let confirmedSelection = removal.selection
    let confirmedGestures = removal.personGestures.count
    let confirmedRedo = removal.redoPersonGestures.count
    removal.personBases = [RemovalPersonSelection(id: 1, mask: Data([0]))]
    removal.refinePerson(1)
    await removal.paint([[0.5, 0.5]], cropInputSize: [16, 8])
    XCTAssertEqual(removal.phase, .ready)
    XCTAssertFalse(removal.message.isEmpty)
    XCTAssertEqual(removal.selection, confirmedSelection)
    XCTAssertEqual(removal.personGestures.count, confirmedGestures)
    XCTAssertEqual(removal.redoPersonGestures.count, confirmedRedo)
    removal.refinePerson(nil)
    XCTAssertFalse(removal.canPaint)
    XCTAssertTrue(removal.canUndoSelection)
    removal.cancel()
    XCTAssertNil(removal.preview)
    XCTAssertEqual(try Data(contentsOf: raw), original)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: directory.appendingPathComponent("photo.xmp").path))
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: directory.appendingPathComponent(".maple/inpaint").path))
    removal.close()
    XCTAssertFalse(removal.canUndoSelection)
    await session.releaseTransientMemory()
  }

  func testInvalidRefinementLeavesPreviousMaskUntouched() throws {
    let base = try circle(0.5, 0.5)
    XCTAssertThrowsError(
      try RemovalBridge.refineSelection(
        base, strokes: [RemovalStroke(points: [], radius: 0.1, subtract: false)]))
    XCTAssertEqual(try RemovalBridge.refineSelection(base, strokes: []), base)
  }
}
