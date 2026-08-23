import XCTest
@testable import MapleUI

final class MuiFacesRowTests: XCTestCase {
    func testCountLabelSingularForOnePerson() {
        XCTAssertEqual(MuiFacesRow.countLabel(count: 1), "1 person")
    }

    func testCountLabelPluralForZeroOrMany() {
        XCTAssertEqual(MuiFacesRow.countLabel(count: 0), "0 people")
        XCTAssertEqual(MuiFacesRow.countLabel(count: 4), "4 people")
    }
}
