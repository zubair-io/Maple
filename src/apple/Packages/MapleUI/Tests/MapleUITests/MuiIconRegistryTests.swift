import SwiftUI
import XCTest
@testable import MapleUI

final class MuiIconRegistryTests: XCTestCase {
    func testUnknownNameReturnsNilSoMuiIconFallsBackToAnSFSymbol() {
        XCTAssertNil(MuiIconRegistry.path(for: "star.fill"))
        XCTAssertNil(MuiIconRegistry.path(for: "cloud.fill")) // close but not the mirrored key
    }

    /// Bottom edge is a flat `H` segment at y=12 between the two side arcs'
    /// endpoints, and the three arcs (radii 2.6 / 3.6 / 2.8, all sweeping
    /// outward per MapleIconShapes.cs) bulge upward from there — so the
    /// glyph's bounding box should sit entirely at or above y=12 and span
    /// roughly the endpoint x-range, without collapsing to a point or
    /// blowing up (which is what a sign error in the arc math would produce).
    func testCloudGlyphBoundingBoxIsPlausible() {
        guard let path = MuiIconRegistry.path(for: "cloud") else {
            return XCTFail("expected a mirrored path for \"cloud\"")
        }
        let rect = path.boundingRect
        XCTAssertEqual(rect.maxY, 12, accuracy: 0.5, "bottom edge is the flat H segment at y=12")
        XCTAssertLessThan(rect.minY, 6, "the arcs bulge well above the baseline")
        XCTAssertGreaterThan(rect.minX, 2, "should stay inside the 16×16 design box")
        XCTAssertLessThan(rect.maxX, 14.1, "should stay inside the 16×16 design box")
    }

    /// No arcs involved, so this one's exact: the rounded-rect frame plus
    /// the two ring ticks poking 1 unit above it.
    func testCalendarGlyphCombinesFrameAndTicks() {
        guard let path = MuiIconRegistry.path(for: "calendar") else {
            return XCTFail("expected a mirrored path for \"calendar\"")
        }
        let rect = path.boundingRect
        XCTAssertEqual(rect.minX, 2.5, accuracy: 0.01)
        XCTAssertEqual(rect.maxX, 13.5, accuracy: 0.01)
        XCTAssertEqual(rect.minY, 2.5, accuracy: 0.01, "the ring ticks start above the frame")
        XCTAssertEqual(rect.maxY, 13.5, accuracy: 0.01)
    }
}
