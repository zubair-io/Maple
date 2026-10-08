// LocalAdjustmentBrushSessionTests.swift — brush raster lifetimes through
// the edit session (#360): undo, redo and reset must restore strokes with a
// live raster. Split from `LocalAdjustmentBrushTests.swift` for its line budget.

import XCTest

@testable import MapleCore

private func sessionTempDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-brush-session-360-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

final class LocalAdjustmentBrushSessionTests: XCTestCase {
    /// A second stroke releases the first stroke's raster, so undo must
    /// re-register the restored stroke rather than restore a dead id.
    @MainActor
    func testUndoAndRedoRebindLiveBrushRasters() throws {
        let dir = try sessionTempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let session = EditSession(asset: AssetRef(url: dir.appendingPathComponent("photo.dng")))
        func stroke(_ x: Double) {
            session.beginBrushStroke()
            session.appendBrushDabs([
                BrushDab(
                    center: MaskPoint(x: x, y: 0.5), radius: 0.05, feather: 0.5, weight: 1,
                    erase: false)
            ])
            session.endBrushStroke()
        }
        func brush() -> (count: Int, id: UInt32) {
            guard case .brush(let dabs, _, let id) = session.model.localAdjustments.first?.mask
            else { return (-1, 0) }
            return (dabs.count, id)
        }
        session.createBrushMask()
        stroke(0.25)
        let first = brush().id
        stroke(0.75)
        let second = brush().id
        XCTAssertNotEqual(first, 0)
        XCTAssertNotEqual(second, first)

        session.undo()
        XCTAssertEqual(brush().count, 1)
        XCTAssertNotEqual(brush().id, 0)
        XCTAssertNotEqual(brush().id, first, "undo restored a released raster id")
        let undone = brush().id

        session.redo()
        XCTAssertEqual(brush().count, 2)
        XCTAssertNotEqual(brush().id, 0)
        XCTAssertNotEqual(brush().id, second, "redo restored a released raster id")
        XCTAssertNotEqual(brush().id, undone)
    }

    /// Reset restores the opened snapshot through the same rebinding: the
    /// original stroke's raster was released by the later stroke.
    @MainActor
    func testResetToOriginalRebindsTheOpenedStroke() throws {
        let dir = try sessionTempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let dab = BrushDab(
            center: MaskPoint(x: 0.25, y: 0.5), radius: 0.05, feather: 0.5, weight: 1, erase: false)
        var opened = AdjustmentModel()
        opened.localAdjustments = [
            LocalAdjustment(
                mask: .brush(dabs: [dab], digest: "", rasterId: 0), adjustments: PartialAdjustments())
        ]
        let session = EditSession(
            asset: AssetRef(url: dir.appendingPathComponent("photo.dng")), model: opened,
            culling: CullingState())
        session.model = session.rebindingBrushRasters(live: AdjustmentModel(), restored: opened)
        guard case .brush(_, _, let first) = session.model.localAdjustments[0].mask else {
            return XCTFail("fixture")
        }
        session.selectedMaskId = session.model.localAdjustments[0].id
        session.beginBrushStroke()
        session.appendBrushDabs([dab])
        session.endBrushStroke()
        session.resetToOriginal()
        guard case .brush(let dabs, _, let id) = session.model.localAdjustments[0].mask else {
            return XCTFail("expected the opened brush")
        }
        XCTAssertEqual(dabs.count, 1)
        XCTAssertNotEqual(id, 0)
        XCTAssertNotEqual(id, first, "reset restored a released raster id")
    }
}
