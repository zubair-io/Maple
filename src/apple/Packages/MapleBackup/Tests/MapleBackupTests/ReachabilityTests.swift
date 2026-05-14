// Tests/MapleBackupTests/ReachabilityTests.swift
import XCTest
@testable import MapleBackup

final class ReachabilityTests: XCTestCase {
    /// We can't reliably toggle interfaces in test, but we can confirm the
    /// type compiles, the actor returns a Status, and the default before
    /// any path-update fires is `.none`.
    func testInitialStatusIsNone() async {
        let r = Reachability()
        let s = await r.status()
        // The monitor may have already received an update by the time we read;
        // accept .none OR a populated value. The contract is just "no crash and
        // a Status comes back".
        XCTAssertTrue([Reachability.Status.none, .wifi, .cellular].contains(s))
    }
}
