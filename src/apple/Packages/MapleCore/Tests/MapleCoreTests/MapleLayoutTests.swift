// MapleLayoutTests.swift — pure-function tests for the responsive-program S0a
// layout signal. Boundary cases at 767 / 768 / 1024 / 1025 establish the
// breakpoint contract used by every other sub-project (S1-S7) per
// docs/spec/responsive-program-s0-primitives.md §2.

import XCTest
@testable import MapleCore

final class MapleLayoutTests: XCTestCase {

    // MARK: MapleLayout.from(width:)

    func testPhoneTierAtMinimumWidth() {
        XCTAssertEqual(MapleLayout.from(width: 0), .phone)
    }

    func testPhoneTierJustBelowThreshold() {
        XCTAssertEqual(MapleLayout.from(width: 767), .phone)
    }

    func testTabletTierAtLowerBoundary() {
        XCTAssertEqual(MapleLayout.from(width: 768), .tablet)
    }

    func testTabletTierInRange() {
        XCTAssertEqual(MapleLayout.from(width: 900), .tablet)
    }

    func testTabletTierAtUpperBoundary() {
        XCTAssertEqual(MapleLayout.from(width: 1024), .tablet)
    }

    func testDesktopTierJustAboveTabletUpper() {
        XCTAssertEqual(MapleLayout.from(width: 1025), .desktop)
    }

    func testDesktopTierAtLargeWidth() {
        XCTAssertEqual(MapleLayout.from(width: 3840), .desktop)
    }

    func testFractionalWidthHonorsExactBoundaries() {
        // 767.99 stays phone-tier; 768.0 crosses into tablet (inclusive lower).
        XCTAssertEqual(MapleLayout.from(width: 767.99), .phone)
        XCTAssertEqual(MapleLayout.from(width: 768.00), .tablet)
        // 1024.0 stays tablet (inclusive upper); anything >1024 is desktop.
        XCTAssertEqual(MapleLayout.from(width: 1024.00), .tablet)
        XCTAssertEqual(MapleLayout.from(width: 1024.01), .desktop)
    }

    func testNegativeWidthFallsToPhone() {
        // Defensive — no caller should pass negative width, but the function
        // is total: anything <768 is phone.
        XCTAssertEqual(MapleLayout.from(width: -100), .phone)
    }

    // MARK: MapleShellKind.from(idiom:)

    func testShellKindFromPhoneIdiomIsPhoneTab() {
        XCTAssertEqual(MapleShellKind.from(idiom: .phone), .phoneTab)
    }

    func testShellKindFromPadIdiomIsPane() {
        XCTAssertEqual(MapleShellKind.from(idiom: .pad), .pane)
    }

    func testShellKindFromMacIdiomIsPane() {
        XCTAssertEqual(MapleShellKind.from(idiom: .mac), .pane)
    }

    func testShellKindFromOtherIdiomIsPane() {
        // tvOS, CarPlay, watchOS, etc. — treat as pane (non-phone)
        XCTAssertEqual(MapleShellKind.from(idiom: .other), .pane)
    }

    // MARK: Macro coverage on the host platform

    func testCurrentShellOnMacIsPane() {
        #if os(macOS)
        XCTAssertEqual(MapleShellKind.current, .pane)
        #else
        throw XCTSkip("Test runs only on macOS host.")
        #endif
    }
}
