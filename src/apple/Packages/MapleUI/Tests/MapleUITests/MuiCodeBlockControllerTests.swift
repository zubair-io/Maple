import XCTest
@testable import MapleUI

/// Records copied text instead of touching the real system pasteboard —
/// the injected shim `MuiCodeBlockController`'s tests assert against.
private final class FakePasteboard: MuiPasteboardWriting {
    private(set) var copiedText: [String] = []

    func copy(_ text: String) {
        copiedText.append(text)
    }
}

/// An injected clock that records every requested delay but never actually
/// sleeps — same pattern as `MuiToastControllerTests`'s `FakeClock`.
private actor FakeClock {
    private(set) var requestedDelaysNs: [UInt64] = []

    func sleep(_ ns: UInt64) {
        requestedDelaysNs.append(ns)
    }
}

@MainActor
final class MuiCodeBlockControllerTests: XCTestCase {
    func testCopyWritesTheExactCodeToTheInjectedPasteboard() async {
        let pasteboard = FakePasteboard()
        let clock = FakeClock()
        let controller = MuiCodeBlockController(pasteboard: pasteboard, sleep: { await clock.sleep($0) })

        await controller.copy("let exposure = 0.3")

        XCTAssertEqual(pasteboard.copiedText, ["let exposure = 0.3"])
    }

    func testCopySetsCopiedTrueThenResetsAfterTheDelay() async {
        let pasteboard = FakePasteboard()
        let clock = FakeClock()
        let controller = MuiCodeBlockController(pasteboard: pasteboard, sleep: { await clock.sleep($0) })

        await controller.copy("code")

        // `copy()` awaits the reset delay before returning, so by the time
        // it returns `copied` has already gone back to false — the delay
        // itself is what we assert on, via the fake clock's recorded call.
        XCTAssertFalse(controller.copied)
        let delays = await clock.requestedDelaysNs
        XCTAssertEqual(delays, [1_500_000_000])
    }

    func testCopyingTwiceWritesBothTimes() async {
        let pasteboard = FakePasteboard()
        let clock = FakeClock()
        let controller = MuiCodeBlockController(pasteboard: pasteboard, sleep: { await clock.sleep($0) })

        await controller.copy("first")
        await controller.copy("second")

        XCTAssertEqual(pasteboard.copiedText, ["first", "second"])
    }
}
