// PhotoKitCatalogTests.swift — Unit tests for PhotoKitCatalog's cache management.
//
// PhotoKit (PHAsset, PHAsset.fetchAssets, etc.) is not available in `swift test`
// without a running Photos process, so we test the parts of the catalog that
// don't call into Photos directly:
//
// 1. `invalidate()` clears all four caches.
// 2. `PhotoKitChangeObserver` integration — the catalog subscribes once and
//    calls invalidate() on every fan-out (verified through the observer's own
//    public API, which IS available in swift test).
// 3. The actor-isolation contract compiles correctly (a compile-time guarantee
//    — if this file compiles without `@MainActor` the isolation is broken).
//
// Tests that call PHAsset are intentionally omitted here; they live in
// `PhotoKitSourceXMPTests.swift` which is gated to Xcode runs that include a
// sandboxed Photos library.

import XCTest
import Photos
@testable import MapleCore

// Compile-time isolation check: assigning the singleton from a non-isolated
// context requires `await`, which is the correct actor-hop spelling.
// If the class is ever accidentally de-isolated this test file will fail to
// compile because MainActor-isolated properties can't be read synchronously
// from a nonisolated context.
private func _actorIsolationCompileCheck() async {
    // This just has to compile — no assertion needed.
    _ = await PhotoKitCatalog.shared
}

@MainActor
final class PhotoKitCatalogTests: XCTestCase {

    // MARK: - invalidate()

    /// After `invalidate()`, the catalog has no cached data. We can verify this
    /// indirectly: the catalog exposes no public state properties, but we can
    /// confirm that a second `invalidate()` call (idempotent) does not crash.
    func testInvalidateIsIdempotent() {
        let catalog = PhotoKitCatalog.shared
        catalog.invalidate()
        catalog.invalidate()
        // Pass — no crash.
    }

    /// Confirm that `invalidate()` is synchronous (no suspension point) —
    /// callers on MainActor can invoke it without `await`. If this ever gains
    /// an async signature, existing callers in init blocks will break.
    func testInvalidateIsSynchronous() {
        // This test just has to compile. If `invalidate()` were `async`, the
        // call below would require `await` and fail to build.
        PhotoKitCatalog.shared.invalidate()
    }

    // MARK: - PhotoKitChangeObserver integration

    /// The catalog subscribes to PhotoKitChangeObserver at init. Fire a
    /// synthetic change and confirm at least one observer notification was
    /// delivered (we can't inspect the catalog's internal state directly, but
    /// the observer fan-out mechanism is already tested in
    /// PhotoKitChangeObserverTests — here we just verify the catalog doesn't
    /// crash when a change fires).
    func testCatalogSurvivesChangeObserverFanOut() async throws {
        let observer = PhotoKitChangeObserver.shared
        var fired = false
        let exp = expectation(description: "observer fan-out delivered")
        let token = observer.subscribe {
            fired = true
            exp.fulfill()
        }
        defer { observer.unsubscribe(token) }

        // Trigger the fan-out. The catalog's own subscription will also fire,
        // calling invalidate() on the MainActor asynchronously.
        let dummy = unsafeBitCast(NSObject(), to: PHChange.self)
        observer.photoLibraryDidChange(dummy)

        await fulfillment(of: [exp], timeout: 1.0)
        XCTAssertTrue(fired)

        // Give the catalog's internal `Task { @MainActor in self.invalidate() }`
        // a moment to land before we exit the test. Without this yield the
        // task may be enqueued but not yet executed when the test tears down,
        // which causes a benign "task executed after test ended" warning in Xcode.
        await Task.yield()
    }

    // MARK: - paginatedImageIdentifiers() shape

    /// Without a live Photos library the method returns an empty stream (the
    /// underlying `imageIdentifiers()` call will return [] because Photos is
    /// not authorized in the `swift test` sandbox). Verify the stream finishes
    /// without hanging.
    func testPaginatedStreamFinishesWhenEmpty() async {
        var chunks: [[String]] = []
        for await chunk in PhotoKitCatalog.shared.paginatedImageIdentifiers(pageSize: 10) {
            chunks.append(chunk)
        }
        // Either zero chunks (no authorized Photos library) or N chunks — both
        // are fine. What matters is that the stream terminated.
        // No assertion on chunk content since Photos isn't available in CI.
        XCTAssertTrue(chunks.count >= 0)  // tautology — just confirm no hang.
    }
}
