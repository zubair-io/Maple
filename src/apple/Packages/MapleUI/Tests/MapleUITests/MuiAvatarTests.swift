import XCTest
@testable import MapleUI

final class MuiAvatarTests: XCTestCase {
    func testInitialsUsesFirstLetterOfFirstTwoWords() {
        XCTAssertEqual(MuiAvatar.initials(for: "Ada Lovelace"), "AL")
    }

    func testInitialsOfSingleWordName() {
        XCTAssertEqual(MuiAvatar.initials(for: "Cher"), "C")
    }

    func testInitialsIgnoresExtraWordsPastTwo() {
        XCTAssertEqual(MuiAvatar.initials(for: "Mary Jane Watson"), "MJ")
    }

    func testInitialsOfEmptyNameIsEmpty() {
        XCTAssertEqual(MuiAvatar.initials(for: ""), "")
    }

    func testInitialsCollapsesRepeatedWhitespace() {
        XCTAssertEqual(MuiAvatar.initials(for: "  Grace   Hopper  "), "GH")
    }

    func testPaletteIndexIsDeterministicForTheSameName() {
        let first = MuiAvatar.paletteIndex(for: "Katherine Johnson")
        let second = MuiAvatar.paletteIndex(for: "Katherine Johnson")
        XCTAssertEqual(first, second)
    }

    func testPaletteIndexIsStableAcrossRepeatedCallsForManyNames() {
        let names = ["Ada Lovelace", "Grace Hopper", "Margaret Hamilton", "Katherine Johnson", "Radia Perlman"]
        let firstPass = names.map(MuiAvatar.paletteIndex(for:))
        let secondPass = names.map(MuiAvatar.paletteIndex(for:))
        XCTAssertEqual(firstPass, secondPass)
    }

    func testPaletteIndexStaysInBounds() {
        for name in ["", "A", "A much longer name than the others", "🎉 emoji name"] {
            let index = MuiAvatar.paletteIndex(for: name)
            XCTAssertGreaterThanOrEqual(index, 0)
            XCTAssertLessThan(index, 5)
        }
    }

    func testDifferentNamesCanLandOnDifferentPaletteEntries() {
        let names = ["Ada Lovelace", "Grace Hopper", "Margaret Hamilton", "Katherine Johnson", "Radia Perlman", "Barbara Liskov"]
        let indices = Set(names.map(MuiAvatar.paletteIndex(for:)))
        XCTAssertGreaterThan(indices.count, 1)
    }
}
