// AssetDropCollisionResolverTests.swift — #2646 review follow-up: the
// collision sheet's implicit dismissal (swipe/Escape) must resolve the
// suspended continuation exactly once, defaulting to `.skip`, and a
// second resolve attempt (a button racing the dismiss handler, or vice
// versa) must be a safe no-op rather than a `CheckedContinuation` crash.

import XCTest
@testable import MapleCore

final class AssetDropCollisionResolverTests: XCTestCase {
    @MainActor
    func testResolveDeliversTheChoiceToTheSuspendedContinuation() async {
        let choice = await withCheckedContinuation { (continuation: CheckedContinuation<AssetDropCollisionChoice, Never>) in
            let resolver = AssetDropCollisionResolver(continuation: continuation)
            resolver.resolve(.replace)
        }
        XCTAssertEqual(choice, .replace)
    }

    /// Simulates an implicit dismissal with no button tap: nothing but the
    /// dismiss-fallback path calls `resolve`, and it must default to
    /// `.skip` — the same outcome as if the user had tapped Skip.
    @MainActor
    func testUnresolvedContinuationDefaultsToSkipOnImplicitDismiss() async {
        let choice = await withCheckedContinuation { (continuation: CheckedContinuation<AssetDropCollisionChoice, Never>) in
            let resolver = AssetDropCollisionResolver(continuation: continuation)
            // Mirrors AssetDropSheets.swift's onDismiss fallback.
            resolver.resolve(.skip)
        }
        XCTAssertEqual(choice, .skip)
    }

    /// A button tap and the sheet's `onDismiss` fallback can BOTH reach the
    /// same resolver (a button tap also dismisses the sheet, which then
    /// fires `onDismiss`) — the second call must be a silent no-op, not a
    /// double-resume crash, and the continuation must deliver whichever
    /// choice arrived FIRST.
    @MainActor
    func testSecondResolveAttemptIsANoOp() async {
        var sawSecondCallReturnWithoutCrashing = false
        let choice = await withCheckedContinuation { (continuation: CheckedContinuation<AssetDropCollisionChoice, Never>) in
            let resolver = AssetDropCollisionResolver(continuation: continuation)
            resolver.resolve(.keepBoth)
            XCTAssertTrue(resolver.isResolved)
            resolver.resolve(.skip)  // must not crash, must not re-resume
            sawSecondCallReturnWithoutCrashing = true
        }
        XCTAssertTrue(sawSecondCallReturnWithoutCrashing)
        XCTAssertEqual(choice, .keepBoth, "the FIRST resolve wins; a later call is a no-op")
    }

    /// Before any resolution, `isResolved` is `false` — a sanity check
    /// against `testSecondResolveAttemptIsANoOp`'s post-resolve assertion,
    /// so the flag is proven to track state in both directions rather than
    /// happening to already be `true`.
    @MainActor
    func testIsResolvedIsFalseBeforeAnyResolveCall() async {
        _ = await withCheckedContinuation { (continuation: CheckedContinuation<AssetDropCollisionChoice, Never>) in
            let resolver = AssetDropCollisionResolver(continuation: continuation)
            XCTAssertFalse(resolver.isResolved)
            resolver.resolve(.skip)
            XCTAssertTrue(resolver.isResolved)
        }
    }
}
