import XCTest
@testable import MapleBackup

final class SanityTests: XCTestCase {
    func testVersion() {
        XCTAssertEqual(MapleBackup.version, "0.1.0")
    }
}
