import XCTest

@testable import MapleCore

/// Deleting a mask is one Undo step (#5122), and Undo brings the layer back
/// with everything it carried.
@MainActor
final class MaskDeleteUndoTests: XCTestCase {
  private func makeSession() throws -> EditSession {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-mask-delete-5122-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    return EditSession(asset: AssetRef(url: dir.appendingPathComponent("photo.dng")))
  }

  func testDeletingAGeometricMaskIsOneUndoEntry() throws {
    let session = try makeSession()
    session.createGeometricMask(.radial)
    let id = try XCTUnwrap(session.selectedMaskId)
    session.setMaskDragActive(true)
    session.model.localAdjustments[0].adjustments.exposure = 0.6
    session.setMaskDragActive(false)
    let edited = session.model
    XCTAssertEqual(session.undoHistory.count, 2)

    session.deleteMask(id: id)

    XCTAssertTrue(session.model.localAdjustments.isEmpty)
    XCTAssertNil(session.selectedMaskId)
    XCTAssertEqual(session.undoHistory.count, 3)
    XCTAssertEqual(session.undoHistory.last?.kind, .mask)
    XCTAssertEqual(session.undoHistory.last?.description, "Delete mask")

    session.undo()
    XCTAssertEqual(session.model, edited, "Undo must restore the layer and its adjustments")
    XCTAssertEqual(session.undoHistory.count, 2)

    session.redo()
    XCTAssertTrue(session.model.localAdjustments.isEmpty)
  }

  func testDeletingOneOfTwoMasksRestoresItInPlace() throws {
    let session = try makeSession()
    session.createGeometricMask(.linear)
    let first = try XCTUnwrap(session.selectedMaskId)
    session.createGeometricMask(.radial)
    let both = session.model

    session.deleteMask(id: first)
    XCTAssertEqual(session.model.localAdjustments.count, 1)

    session.undo()
    XCTAssertEqual(session.model, both)
    XCTAssertEqual(session.model.localAdjustments.first?.id, first)
  }

  func testDeletingAMissingMaskRecordsNothing() throws {
    let session = try makeSession()
    session.createGeometricMask(.linear)
    session.deleteMask(id: UUID())
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(session.model.localAdjustments.count, 1)
  }

  func testAHiddenMaskComesBackShownAfterDeleteAndUndo() throws {
    let session = try makeSession()
    session.createGeometricMask(.linear)
    let id = try XCTUnwrap(session.selectedMaskId)
    session.setMaskEnabled(id: id, enabled: false)

    session.deleteMask(id: id)
    XCTAssertTrue(session.disabledMaskIds.isEmpty)
    session.undo()

    XCTAssertTrue(session.isMaskEnabled(id: id))
    XCTAssertEqual(session.renderModel, session.model)
  }

  /// A deleted brush layer's raster is released; Undo must register a live
  /// one from the layer's dabs rather than restore the dead id.
  func testUndoingABrushMaskDeleteRebindsItsRaster() throws {
    let session = try makeSession()
    session.createBrushMask()
    let id = try XCTUnwrap(session.selectedMaskId)
    session.beginBrushStroke()
    session.appendBrushDabs([
      BrushDab(
        center: MaskPoint(x: 0.25, y: 0.5), radius: 0.05, feather: 0.5, weight: 1, erase: false)
    ])
    session.endBrushStroke()
    guard case .brush(let dabs, _, let painted) = session.model.localAdjustments[0].mask else {
      return XCTFail("expected a brush layer")
    }
    XCTAssertNotEqual(painted, 0)

    session.deleteMask(id: id)
    session.undo()

    guard case .brush(let restored, _, let rebound) = session.model.localAdjustments.first?.mask
    else { return XCTFail("Undo did not restore the brush layer") }
    XCTAssertEqual(restored, dabs)
    XCTAssertNotEqual(rebound, 0)
    XCTAssertNotEqual(rebound, painted, "Undo restored a released raster id")
  }
}
