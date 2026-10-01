import XCTest

@testable import MapleCore

@MainActor
final class MaskGroupAuthoringTests: EditorTestCase {
  private func group(_ session: EditSession) throws -> MaskGroup {
    guard case .group(let group) = session.selectedMaskLayer?.mask else {
      XCTFail("Expected selected group")
      throw XMPError.parseError("group missing")
    }
    return group
  }
  func testComposePreservesControlsRangeIdentityAndImportedMetadataAsOneUndoEntry() throws {
    let session = EditSession.preview()
    session.createGeometricMask(.radial)
    session.model.localAdjustments[0].range = .skinTone
    session.model.localAdjustments[0].adjustments.exposure = 0.7
    session.model.localAdjustments[0].xmpGroupSlot = 9
    let original = try XCTUnwrap(session.selectedMaskLayer)
    session.addMaskComponent(.linear, combine: .subtract)
    XCTAssertEqual(session.selectedMaskComponentIndex, 1)
    XCTAssertEqual(session.model.localAdjustments.count, 1)
    XCTAssertEqual(session.selectedMaskLayer?.id, original.id)
    XCTAssertEqual(session.selectedMaskLayer?.adjustments, original.adjustments)
    XCTAssertEqual(session.selectedMaskLayer?.range, original.range)
    XCTAssertEqual(session.selectedMaskLayer?.xmpGroupSlot, 9)
    XCTAssertEqual(try group(session).components[0].mask, original.mask)
    session.undo()
    XCTAssertEqual(session.selectedMaskLayer, original)
    session.redo()
    XCTAssertEqual(try group(session).components.count, 2)
  }
  func testComponentGeometryGestureEditsOnlySelectedLeafAndUndoesOnce() throws {
    let session = EditSession.preview()
    session.createGeometricMask(.linear)
    session.addMaskComponent(.radial, combine: .intersect)
    let original = try group(session)
    let first = original.components[0]
    session.setMaskDragActive(true)
    let changed = LocalMask.radial(
      center: MaskPoint(x: 0.3, y: 0.4), radii: MaskPoint(x: 0.2, y: 0.3),
      angle: 0.5, feather: 0.2, invert: false)
    session.setMaskGeometry(changed)
    session.setMaskOpacity(0.4)
    session.setMaskDragActive(false)
    XCTAssertEqual(try group(session).components[0], first)
    XCTAssertEqual(session.selectedMaskGeometry, changed)
    session.undo()
    XCTAssertEqual(try group(session), original)
  }
  func testDeletingEarlierComponentRetainsSelectionAndLastComponentCannotBeDeleted() throws {
    let session = EditSession.preview()
    session.createGeometricMask(.linear)
    session.addMaskComponent(.radial, combine: .subtract)
    session.addMaskComponent(.linear, combine: .intersect)
    let selected = session.selectedMaskComponent
    session.removeMaskComponent(0)
    XCTAssertEqual(session.selectedMaskComponentIndex, 1)
    XCTAssertEqual(session.selectedMaskComponent, selected)
    session.removeMaskComponent(-1)
    XCTAssertEqual(session.selectedMaskComponent, selected)
    session.removeMaskComponent(1)
    session.removeMaskComponent(0)
    XCTAssertEqual(try group(session).components.count, 1)
    XCTAssertEqual(session.selectedMaskComponentIndex, 0)
  }
  func testCombineAndBothInversionsHaveSeparateUndoEntries() throws {
    let session = EditSession.preview()
    session.createGeometricMask(.radial)
    session.addMaskComponent(.linear, combine: .subtract)
    let original = try group(session)
    session.setMaskComponentCombine(.intersect)
    session.setMaskComponentInverted(true)
    session.setMaskGroupInverted(true)
    XCTAssertTrue(try group(session).invert)
    session.undo()
    XCTAssertFalse(try group(session).invert)
    session.undo()
    XCTAssertFalse(try group(session).components[1].invert)
    session.undo()
    XCTAssertEqual(try group(session), original)
  }
  func testOpacityWrapsLegacyLayerWithOneGestureAndClampsWithoutAcceptingNan() throws {
    let session = EditSession.preview()
    session.createGeometricMask(.linear)
    let original = session.selectedMaskLayer
    session.setMaskOpacity(1)
    XCTAssertEqual(session.selectedMaskLayer, original)
    session.setMaskDragActive(true)
    session.setMaskOpacity(0.5)
    session.setMaskOpacity(0.25)
    session.setMaskOpacity(.nan)
    session.setMaskDragActive(false)
    XCTAssertEqual(try group(session).opacity, 0.25)
    session.undo()
    XCTAssertEqual(session.selectedMaskLayer, original)
    session.setMaskOpacity(-1)
    XCTAssertEqual(try group(session).opacity, 0)
    session.setMaskOpacity(2)
    XCTAssertEqual(try group(session).opacity, 1)
    session.setMaskDragActive(false)
  }
  func testSwitchingLayersAndUndoShrinkClampComponentSelection() throws {
    let session = EditSession.preview()
    session.createGeometricMask(.linear)
    let first = session.selectedMaskId
    session.addMaskComponent(.radial, combine: .subtract)
    session.addMaskComponent(.linear, combine: .intersect)
    XCTAssertEqual(session.selectedMaskComponentIndex, 2)
    session.undo()
    XCTAssertEqual(session.selectedMaskComponentIndex, 1)
    session.createGeometricMask(.radial)
    session.addMaskComponent(.linear, combine: .subtract)
    session.selectedMaskId = first
    XCTAssertEqual(session.selectedMaskComponentIndex, 0)
  }
  func testNonGestureOpacityEditEndsImmediatelyAndUndoesOnce() throws {
    let session = EditSession.preview()
    session.createGeometricMask(.radial)
    let initial = try XCTUnwrap(session.selectedMaskLayer)
    session.setMaskOpacity(0.6)
    XCTAssertFalse(session.isAdjustingMask)
    XCTAssertTrue(session.showsMaskOverlay)
    XCTAssertEqual(try group(session).opacity, 0.6)
    session.undo()
    XCTAssertEqual(session.selectedMaskLayer, initial)
  }

}
