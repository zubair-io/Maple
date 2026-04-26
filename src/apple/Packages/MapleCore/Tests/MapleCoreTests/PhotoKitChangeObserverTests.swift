// PhotoKitChangeObserverTests.swift — covers the subscriber fan-out used by
// `PhotoKitSource` and `LibrarySidebar` to invalidate cached state when the
// user adds/removes photos in another app. The actual `photoLibraryDidChange`
// callback can't be unit-tested without a real Photos library mutation, so we
// drive the public surface (`subscribe`, `unsubscribe`, manual fan-out via the
// `PHPhotoLibraryChangeObserver` conformance) directly.

import XCTest
@testable import MapleCore
import Photos

final class PhotoKitChangeObserverTests: XCTestCase {

    func testSubscribeReturnsUniqueTokens() {
        let observer = PhotoKitChangeObserver.shared
        let t1 = observer.subscribe { }
        let t2 = observer.subscribe { }
        XCTAssertNotEqual(t1, t2, "Each subscription must get its own token so unsubscribe targets the right slot")
        observer.unsubscribe(t1)
        observer.unsubscribe(t2)
    }

    func testFanOutInvokesAllActiveSubscribers() {
        let observer = PhotoKitChangeObserver.shared
        let exp1 = expectation(description: "subscriber A fired")
        let exp2 = expectation(description: "subscriber B fired")

        let t1 = observer.subscribe { exp1.fulfill() }
        let t2 = observer.subscribe { exp2.fulfill() }

        // Manually invoke the PHPhotoLibraryChangeObserver entry point —
        // PHChange's init is private so we can't synthesize one, but the
        // observer's implementation only fans out and never inspects the
        // change instance, so the cast through Any to PHChange.self is
        // never exercised in this method.
        let dummy = unsafeBitCast(NSObject(), to: PHChange.self)
        observer.photoLibraryDidChange(dummy)

        wait(for: [exp1, exp2], timeout: 1.0)
        observer.unsubscribe(t1)
        observer.unsubscribe(t2)
    }

    func testUnsubscribeRemovesHandler() {
        let observer = PhotoKitChangeObserver.shared
        let exp = expectation(description: "remaining subscriber fires")
        let exp2 = expectation(description: "removed subscriber must NOT fire")
        exp2.isInverted = true

        let removed = observer.subscribe { exp2.fulfill() }
        observer.unsubscribe(removed)

        let kept = observer.subscribe { exp.fulfill() }

        let dummy = unsafeBitCast(NSObject(), to: PHChange.self)
        observer.photoLibraryDidChange(dummy)

        wait(for: [exp, exp2], timeout: 0.5)
        observer.unsubscribe(kept)
    }

    func testIsSingleton() {
        XCTAssertTrue(PhotoKitChangeObserver.shared === PhotoKitChangeObserver.shared,
                      "PhotoKit must see exactly one observer instance per process so register(:) survives source teardown")
    }
}
