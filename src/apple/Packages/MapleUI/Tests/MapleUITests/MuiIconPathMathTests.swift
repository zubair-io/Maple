import SwiftUI
import XCTest
@testable import MapleUI

final class MuiIconPathMathTests: XCTestCase {
    func testMoveLineHorizontalVerticalClose() {
        let path = MuiIconPathMath.path(for: "M0 0H10V10H0Z")
        assertRect(path.boundingRect, CGRect(x: 0, y: 0, width: 10, height: 10))
    }

    func testRelativeCommandsMatchAbsoluteEquivalent() {
        let absolute = MuiIconPathMath.path(for: "M2 2L8 2L8 8L2 8Z")
        let relative = MuiIconPathMath.path(for: "M2 2l6 0l0 6l-6 0Z")
        assertRect(absolute.boundingRect, relative.boundingRect)
    }

    /// Two 180° arcs (large-arc-flag 0, sweep-flag 1) from the top of a
    /// circle to the bottom and back trace the full circle — a ground-truth
    /// shape to validate the endpoint-to-center arc math against, decoupled
    /// from the cloud glyph's own more intricate geometry.
    func testCircularArcMatchesKnownCircle() {
        let path = MuiIconPathMath.path(for: "M0 -5A5 5 0 0 1 0 5A5 5 0 0 1 0 -5Z")
        assertRect(path.boundingRect, CGRect(x: -5, y: -5, width: 10, height: 10), tolerance: 1)
    }

    /// SVG arc flags are single `0`/`1` digits that need not be
    /// whitespace-separated from the number that follows — e.g. `"015 5"`
    /// is `largeArc=0`, `sweep=1`, then the endpoint `x=5`. A naive numeric
    /// scan would swallow `015` as one value and misparse the endpoint.
    func testArcFlagsWithoutSeparatingWhitespaceParseCorrectly() {
        let path = MuiIconPathMath.path(for: "M0 0A5 5 0 015 5")
        let rect = path.boundingRect
        XCTAssertEqual(rect.maxX, 5, accuracy: 0.01, "endpoint x=5 should be within the path's bounds")
        XCTAssertEqual(rect.maxY, 5, accuracy: 0.01, "endpoint y=5 should be within the path's bounds")
        XCTAssertLessThanOrEqual(rect.minX, 0.01)
        XCTAssertLessThanOrEqual(rect.minY, 0.01)
    }

    func testUnknownCommandCharacterIsIgnoredRatherThanCrashing() {
        // No 'Q' handler exists (curves are out of scope); the parser should
        // simply stop rather than infinite-loop or trap.
        let path = MuiIconPathMath.path(for: "M0 0Q5 5 10 10")
        XCTAssertEqual(path.boundingRect, .zero)
    }

    private func assertRect(_ a: CGRect, _ b: CGRect, tolerance: CGFloat = 0.01, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(a.minX, b.minX, accuracy: tolerance, file: file, line: line)
        XCTAssertEqual(a.minY, b.minY, accuracy: tolerance, file: file, line: line)
        XCTAssertEqual(a.maxX, b.maxX, accuracy: tolerance, file: file, line: line)
        XCTAssertEqual(a.maxY, b.maxY, accuracy: tolerance, file: file, line: line)
    }
}
