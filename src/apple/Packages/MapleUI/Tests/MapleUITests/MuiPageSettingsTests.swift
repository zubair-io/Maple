import XCTest
@testable import MapleUI

final class MuiPageSettingsTests: XCTestCase {
    private let users: [MuiManagedUser] = [
        MuiManagedUser(id: "1", name: "Zubair Lawrence", email: "zubair@justmaple.app", role: "Admin"),
    ]

    func testInvitedAppendsAMemberDerivedFromTheEmail() {
        let next = MuiPageSettings.invited(users, email: "ada@justmaple.app")
        XCTAssertEqual(next.count, 2)
        XCTAssertEqual(next[1].email, "ada@justmaple.app")
        XCTAssertEqual(next[1].name, "ada")
        XCTAssertEqual(next[1].role, "Member")
    }

    func testInvitedAssignsAnIdThatDoesNotCollideWithExistingOnes() {
        let next = MuiPageSettings.invited(users, email: "grace@justmaple.app")
        XCTAssertEqual(next[1].id, "2")
    }

    func testInvitedOnAnEmptyListStartsAtIdOne() {
        let next = MuiPageSettings.invited([], email: "ada@justmaple.app")
        XCTAssertEqual(next[0].id, "1")
    }
}
