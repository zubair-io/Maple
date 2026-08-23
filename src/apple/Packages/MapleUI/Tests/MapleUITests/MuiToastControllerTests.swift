import XCTest
@testable import MapleUI

/// An injected clock that records every requested delay but never actually
/// sleeps, so these tests run instantly instead of racing `autoDismissMs`
/// against the real wall clock. An actor so its `sleep` method satisfies
/// the controller's `@Sendable` loader-closure requirement.
private actor FakeClock {
    private(set) var requestedDelaysNs: [UInt64] = []

    func sleep(_ ns: UInt64) {
        requestedDelaysNs.append(ns)
    }
}

@MainActor
final class MuiToastControllerTests: XCTestCase {
    func testPresentTransitionsToRestingImmediately() async {
        let clock = FakeClock()
        let controller = MuiToastController(autoDismissMs: nil, sleep: { await clock.sleep($0) })

        await controller.present()

        XCTAssertEqual(controller.phase, .resting)
    }

    func testNilAutoDismissNeverLeavesRestingOnItsOwn() async {
        let clock = FakeClock()
        let controller = MuiToastController(autoDismissMs: nil, sleep: { await clock.sleep($0) })

        await controller.present()

        XCTAssertEqual(controller.phase, .resting)
        let delays = await clock.requestedDelaysNs
        XCTAssertTrue(delays.isEmpty)
    }

    func testAutoDismissWaitsTheConfiguredDurationThenLeaves() async {
        let clock = FakeClock()
        var dismissedCount = 0
        let controller = MuiToastController(
            autoDismissMs: 3000,
            sleep: { await clock.sleep($0) },
            onDismissed: { dismissedCount += 1 }
        )

        await controller.present()

        XCTAssertEqual(controller.phase, .dismissed)
        XCTAssertEqual(dismissedCount, 1)
        // First delay is the auto-dismiss wait (3000ms); second is the
        // sheet-dismiss exit-motion duration.
        let delays = await clock.requestedDelaysNs
        XCTAssertEqual(delays.first, 3_000_000_000)
    }

    func testDismissedFiresExactlyOnceEvenIfDismissIsCalledTwice() async {
        let clock = FakeClock()
        var dismissedCount = 0
        let controller = MuiToastController(
            autoDismissMs: nil,
            sleep: { await clock.sleep($0) },
            onDismissed: { dismissedCount += 1 }
        )

        await controller.present()
        await controller.dismiss()
        await controller.dismiss()

        XCTAssertEqual(dismissedCount, 1)
        XCTAssertEqual(controller.phase, .dismissed)
    }

    func testDismissAfterAlreadyDismissedDoesNotRequestAnotherSleep() async {
        let clock = FakeClock()
        let controller = MuiToastController(autoDismissMs: nil, sleep: { await clock.sleep($0) })

        await controller.present()
        await controller.dismiss()
        let delaysAfterFirstDismiss = await clock.requestedDelaysNs.count
        await controller.dismiss()

        let finalDelays = await clock.requestedDelaysNs.count
        XCTAssertEqual(finalDelays, delaysAfterFirstDismiss)
    }
}
