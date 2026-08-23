import XCTest
@testable import MapleUI

final class MuiBadgeTests: XCTestCase {
    func testCountVariantUsesValueAsAccessibleLabelByDefault() {
        XCTAssertEqual(MuiBadge.accessibleLabel(variant: .count, value: "3", label: nil), "3")
    }

    func testExplicitLabelOverridesValue() {
        XCTAssertEqual(MuiBadge.accessibleLabel(variant: .count, value: "3", label: "3 unread"), "3 unread")
    }

    func testRatingVariantAnnouncesNumericRating() {
        XCTAssertEqual(MuiBadge.accessibleLabel(variant: .rating, value: "4", label: nil), "Rating 4")
    }

    func testSignalVariantUsesValueAsAccessibleLabelByDefault() {
        XCTAssertEqual(MuiBadge.accessibleLabel(variant: .signal, value: "Needs review", label: nil), "Needs review")
    }
}
