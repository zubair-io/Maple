import XCTest
@testable import MapleUI

final class MuiFilmstripRowTests: XCTestCase {
    func testNextActiveFollowsTheTappedItem() {
        XCTAssertEqual(MuiFilmstripRow.nextActive(tapped: "3"), "3")
    }

    func testNextActiveFollowsAFreshTapEvenAfterAPriorSelection() {
        // activeId "follows" selection unconditionally — there's no
        // toggle-off or "reselecting the active item is a no-op" special
        // case (unlike MuiChipRow.nextSelection's re-tap no-op, which
        // still resolves to the same id — here every tap simply becomes
        // the new active id, regardless of what was active before).
        XCTAssertEqual(MuiFilmstripRow.nextActive(tapped: "1"), "1")
        XCTAssertEqual(MuiFilmstripRow.nextActive(tapped: "2"), "2")
    }
}
