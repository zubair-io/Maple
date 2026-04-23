import XCTest
@testable import MapleCore

final class MapleCoreTests: XCTestCase {
    func testVersionStringIsSane() {
        let v = MapleCore.version()
        XCTAssertTrue(v.contains("MapleCore"), "version string was \(v)")
    }
}
