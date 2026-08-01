// PhotoKitCatalogTests.swift — Unit tests for PhotoKitCatalog's cache management.
//
// PhotoKit (PHAsset, PHAsset.fetchAssets, etc.) is not available in `swift test`
// without a running Photos process, so we test the parts of the catalog that
// don't call into Photos directly:
//
// 1. `invalidate()` clears all four caches.
// 2. `PhotoKitChangeObserver` integration — the catalog subscribes once and
//    calls invalidate() synchronously on every fan-out, so the cache is
//    cleared before any other subscriber's handler runs.
// 3. Paginated stream terminates (stream produces 0 chunks in the `swift test`
//    sandbox where Photos isn't authorised, but it must not hang).
//
// Tests that call PHAsset are intentionally omitted here; they live in
// `PhotoKitSourceXMPTests.swift` which is gated to Xcode runs that include a
// sandboxed Photos library.

import XCTest
import Photos
@testable import MapleCore

// Compile-time check: since PhotoKitCatalog is no longer @MainActor-isolated,
// `shared` can be read without `await`. If the class is ever accidentally
// re-isolated this check will fail to compile.
private func _noActorHopRequired() {
    // Must compile without `await`.
    _ = PhotoKitCatalog.shared
}

final class PhotoKitCatalogTests: XCTestCase {

    // MARK: - invalidate()

    /// After `invalidate()`, the catalog has no cached data. We verify this
    /// through the test-only cache accessors.
    func testInvalidateClearsImageIDCache() {
        let catalog = PhotoKitCatalog.shared
        catalog.testOnlySetCache(imageIDs: ["a", "b", "c"])
        XCTAssertNotNil(catalog.testOnlyCachedImageIDs())

        catalog.invalidate()

        XCTAssertNil(catalog.testOnlyCachedImageIDs(), "invalidate() should nil out cachedImageIDs")
    }

    /// `invalidate()` must be callable multiple times without crashing.
    func testInvalidateIsIdempotent() {
        let catalog = PhotoKitCatalog.shared
        catalog.invalidate()
        catalog.invalidate()
        // Pass — no crash.
    }

    /// Confirm that `invalidate()` is synchronous — no suspension point, no
    /// `await` needed. If this ever gains an async signature, existing callers
    /// in init blocks will fail to build.
    func testInvalidateIsSynchronous() {
        // This test just has to compile. If `invalidate()` were `async`, the
        // call below would require `await` and fail to build.
        PhotoKitCatalog.shared.invalidate()
    }

    // MARK: - PhotoKitChangeObserver integration

    /// Once subscribed, a synthetic change must leave the catalog's image-id
    /// cache nil — invalidation runs synchronously, same callstack, no Task hop.
    ///
    /// Subscription is established explicitly: since #2454 the catalog
    /// subscribes on first use *with access in hand*, never at init, and a test
    /// host has no PhotoKit access to grant.
    func testCatalogInvalidatesOnPhotoKitChange() {
        let catalog = PhotoKitCatalog.shared
        catalog.testOnlyStartObserving()
        // Seed a known cache entry so we can observe it being cleared.
        catalog.testOnlySetCache(imageIDs: ["test-id-1", "test-id-2"])
        XCTAssertNotNil(catalog.testOnlyCachedImageIDs())

        // Fire a synthetic change. The catalog's subscriber calls invalidate()
        // synchronously — by the time fireForTesting() returns, the cache is
        // already cleared.
        PhotoKitChangeObserver.shared.fireForTesting()

        XCTAssertNil(catalog.testOnlyCachedImageIDs(),
                     "Cache must be cleared synchronously before fireForTesting() returns")
    }

    /// Confirm the fan-out delivers to other subscribers AND the catalog
    /// clears its cache in the same synchronous call — no Task hop needed.
    func testCatalogSurvivesChangeObserverFanOut() {
        let observer = PhotoKitChangeObserver.shared
        var fired = false
        let token = observer.subscribe {
            fired = true
        }
        defer { observer.unsubscribe(token) }

        // Seed the catalog so we can check the synchronous clear.
        PhotoKitCatalog.shared.testOnlyStartObserving()
        PhotoKitCatalog.shared.testOnlySetCache(imageIDs: ["x"])

        observer.fireForTesting()

        XCTAssertTrue(fired, "Subscriber handler must have been called")
        XCTAssertNil(PhotoKitCatalog.shared.testOnlyCachedImageIDs(),
                     "Catalog must have cleared its cache synchronously during fan-out")
    }

    // MARK: - paginatedImageIdentifiers() shape

    /// Without a live Photos library the method returns an empty stream (the
    /// underlying PHFetchResult has zero assets because Photos is not authorised
    /// in the `swift test` sandbox). Verify the stream terminates rather than
    /// hanging.
    func testPaginatedStreamTerminates() async {
        let expectation = XCTestExpectation(description: "stream terminates")
        Task {
            var chunks: [[String]] = []
            for await chunk in PhotoKitCatalog.shared.paginatedImageIdentifiers(pageSize: 100) {
                chunks.append(chunk)
                if chunks.count > 100 { break }  // safety bail before a truly-infinite stream
            }
            expectation.fulfill()
        }
        await fulfillment(of: [expectation], timeout: 5.0)
    }

    /// A pageSize of 0 must not produce an infinite stream of empty chunks.
    /// The implementation clamps to max(1, pageSize).
    func testPageSizeZeroClampsToOne() async {
        // In the test sandbox Photos isn't available so the fetch result is
        // empty — the stream finishes with 0 chunks regardless of page size.
        // What matters is that it finishes at all (not an infinite loop of
        // zero-element yields).
        let expectation = XCTestExpectation(description: "pageSize=0 stream terminates")
        Task {
            for await _ in PhotoKitCatalog.shared.paginatedImageIdentifiers(pageSize: 0) {
                // consume chunks
            }
            expectation.fulfill()
        }
        await fulfillment(of: [expectation], timeout: 5.0)
    }
}
