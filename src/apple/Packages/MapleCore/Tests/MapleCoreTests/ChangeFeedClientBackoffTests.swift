import XCTest
@testable import MapleCore

/// Regression tests for the SSE reconnect backoff policy. The bug these
/// guard against: a clean (non-throwing) server close used to reset the
/// backoff and reconnect with *zero* delay, so a server/proxy that
/// promptly closes an idle stream turned the loop into a connect→EOF
/// hot loop — a continuous battery drain on the backgrounded File
/// Provider extension even when nothing was syncing.
final class ChangeFeedClientBackoffTests: XCTestCase {
    private let floor = ChangeFeedClient.minReconnectDelayNs
    private let cap = ChangeFeedClient.maxReconnectDelayNs
    private let healthy = ChangeFeedClient.healthyConnectionNs

    /// A connection that ends almost immediately must NEVER yield a
    /// zero delay — that was the hot-loop bug. It must wait at least the
    /// floor.
    func testImmediateCloseNeverReturnsZeroDelay() {
        let delay = ChangeFeedClient.nextReconnectDelay(
            connectionLivedNs: 0, previousDelayNs: floor)
        XCTAssertGreaterThanOrEqual(delay, floor,
            "an instant close must back off at least the floor, never 0")
    }

    /// Repeated short-lived (flapping) connections grow the delay
    /// exponentially and clamp at the cap — they don't spin.
    func testFlappingConnectionBacksOffExponentiallyAndCaps() {
        var delay = floor
        let observed = (0..<8).map { _ -> UInt64 in
            delay = ChangeFeedClient.nextReconnectDelay(
                connectionLivedNs: 0, previousDelayNs: delay)
            return delay
        }
        // 1s -> 2,4,8,16,16,16,16,16
        XCTAssertEqual(Array(observed.prefix(4)), [2, 4, 8, 16].map { $0 * 1_000_000_000 })
        XCTAssertTrue(observed.allSatisfy { $0 <= cap })
        XCTAssertEqual(observed.last, cap, "must clamp at the cap, not grow unbounded")
    }

    /// A connection that lived long enough to be healthy resets the
    /// delay back to the floor regardless of how high it had climbed.
    func testHealthyConnectionResetsToFloor() {
        let delay = ChangeFeedClient.nextReconnectDelay(
            connectionLivedNs: healthy, previousDelayNs: cap)
        XCTAssertEqual(delay, floor,
            "a healthy connection should drop the backoff back to the floor")
    }

    /// Just under the healthy threshold is still treated as a flap.
    func testJustUnderHealthyThresholdStillBacksOff() {
        let delay = ChangeFeedClient.nextReconnectDelay(
            connectionLivedNs: healthy - 1, previousDelayNs: floor)
        XCTAssertEqual(delay, floor * 2,
            "below the healthy threshold the delay must grow, not reset")
    }
}
