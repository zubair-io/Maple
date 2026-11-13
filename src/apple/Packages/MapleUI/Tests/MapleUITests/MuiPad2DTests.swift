import SwiftUI
import XCTest

@testable import MapleUI

/// Component-level `value(atLocation:)` cases, mirroring the web
/// reference's `mui-pad-2d.component.spec.ts` fixture geometry (a 100×100
/// pad) so the two platforms agree on the same pointer positions.
final class MuiPad2DTests: XCTestCase {
  private let size: CGFloat = 100

  func testTopLeftCornerIsMinusOneOne() {
    let value = MuiPad2D.value(atLocation: CGPoint(x: 0, y: 0), size: size)
    XCTAssertEqual(value.x, -1)
    XCTAssertEqual(value.y, 1)
  }

  func testCenterIsOrigin() {
    let value = MuiPad2D.value(atLocation: CGPoint(x: 50, y: 50), size: size)
    XCTAssertEqual(value.x, 0)
    XCTAssertEqual(value.y, 0)
  }

  func testBottomRightCornerIsOneMinusOne() {
    let value = MuiPad2D.value(atLocation: CGPoint(x: 100, y: 100), size: size)
    XCTAssertEqual(value.x, 1)
    XCTAssertEqual(value.y, -1)
  }

  func testZeroSizeReturnsOrigin() {
    let value = MuiPad2D.value(atLocation: CGPoint(x: 10, y: 10), size: 0)
    XCTAssertEqual(value.x, 0)
    XCTAssertEqual(value.y, 0)
  }

  // A fill-mode pad is not square: each axis maps over its own extent.
  private let box = CGSize(width: 200, height: 100)

  func testEachAxisOfAWidePadSpansItsOwnExtent() {
    XCTAssertEqual(
      MuiPad2D.value(atLocation: CGPoint(x: 0, y: 0), in: box), MuiPad2DValue(x: -1, y: 1))
    XCTAssertEqual(
      MuiPad2D.value(atLocation: CGPoint(x: 100, y: 50), in: box), MuiPad2DValue(x: 0, y: 0))
    XCTAssertEqual(
      MuiPad2D.value(atLocation: CGPoint(x: 150, y: 25), in: box), MuiPad2DValue(x: 0.5, y: 0.5))
    XCTAssertEqual(
      MuiPad2D.value(atLocation: CGPoint(x: 200, y: 100), in: box), MuiPad2DValue(x: 1, y: -1))
  }

  func testADragPastTheEdgeStaysOnThePad() {
    XCTAssertEqual(
      MuiPad2D.value(atLocation: CGPoint(x: 260, y: -40), in: box), MuiPad2DValue(x: 1, y: 1))
  }

  func testAnEmptyBoxReturnsOrigin() {
    XCTAssertEqual(
      MuiPad2D.value(atLocation: CGPoint(x: 10, y: 10), in: CGSize(width: 200, height: 0)),
      MuiPad2DValue(x: 0, y: 0))
  }

  func testThePuckSitsWhereItsValueWasPicked() {
    for point in [CGPoint(x: 0, y: 0), CGPoint(x: 150, y: 25), CGPoint(x: 200, y: 100)] {
      let value = MuiPad2D.value(atLocation: point, in: box)
      XCTAssertEqual(MuiPad2D.location(of: value, in: box), point)
    }
  }

  func testBuiltInStepsMoveOneAxisAndClamp() {
    let origin = MuiPad2DValue(x: 0, y: 0)
    XCTAssertEqual(MuiPad2D.stepped(origin, .right), MuiPad2DValue(x: 0.05, y: 0))
    XCTAssertEqual(MuiPad2D.stepped(origin, .left), MuiPad2DValue(x: -0.05, y: 0))
    XCTAssertEqual(MuiPad2D.stepped(origin, .up), MuiPad2DValue(x: 0, y: 0.05))
    XCTAssertEqual(MuiPad2D.stepped(origin, .down), MuiPad2DValue(x: 0, y: -0.05))
    let corner = MuiPad2DValue(x: 1, y: -1)
    XCTAssertEqual(MuiPad2D.stepped(corner, .right), corner)
    XCTAssertEqual(MuiPad2D.stepped(corner, .down), corner)
  }

  @MainActor
  func testEditingCallbacksAndValueReachTheConsumer() {
    var stored = MuiPad2DValue(x: 0, y: 0)
    var events: [Bool] = []
    var steps: [MuiPad2DDirection] = []
    let pad = MuiPad2D(
      value: Binding(get: { stored }, set: { stored = $0 }), size: nil,
      onEditingChanged: { events.append($0) },
      onStep: {
        steps.append($0)
        return nil
      })
    pad.onEditingChanged?(true)
    pad.value = MuiPad2DValue(x: 0.25, y: -0.5)
    pad.onStep?(.up)
    pad.onEditingChanged?(false)
    XCTAssertEqual(stored, MuiPad2DValue(x: 0.25, y: -0.5))
    XCTAssertEqual(events, [true, false])
    XCTAssertEqual(steps, [.up])
    XCTAssertNil(pad.size)
  }

  /// A key step against an edge used to open an edit anyway, and opening one
  /// drops the consumer's redo stack.
  @MainActor
  func testAStepThatCannotMoveTheValueHasNoWrite() {
    var stored = MuiPad2DValue(x: 1, y: 0)
    let builtIn = MuiPad2D(value: Binding(get: { stored }, set: { stored = $0 }))
    XCTAssertNil(builtIn.stepWrite(.right))
    builtIn.stepWrite(.left)?()
    XCTAssertEqual(stored, MuiPad2D.stepped(MuiPad2DValue(x: 1, y: 0), .left))
    XCTAssertLessThan(stored.x, 1)

    var wrote = false
    let consumer = MuiPad2D(
      value: .constant(MuiPad2DValue(x: 0, y: 0)),
      onStep: { $0 == .up ? { wrote = true } : nil })
    XCTAssertNil(consumer.stepWrite(.down))
    consumer.stepWrite(.up)?()
    XCTAssertTrue(wrote)
  }
}
