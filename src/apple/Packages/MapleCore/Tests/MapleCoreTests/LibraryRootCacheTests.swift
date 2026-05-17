import XCTest
@testable import MapleCore

final class LibraryRootCacheTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        UserDefaults(suiteName: "test-\(UUID().uuidString)")!
    }

    private func mkRoot(_ id: String, fileCount: Int = 1) -> LibraryRoot {
        LibraryRoot(id: id, path: "/p/\(id)", label: id, fileCount: fileCount)
    }

    /// Cold path with no disk cache: the cache must await the fetcher
    /// and return its result.
    func testColdDiskMiss_RunsFetcher() async throws {
        let defaults = freshDefaults()
        let counter = AsyncCounter()
        let primed = [mkRoot("a")]
        let cache = LibraryRootCache(domainID: "default",
                                     defaults: defaults,
                                     fetcher: {
            await counter.bump()
            return primed
        })
        let result = try await cache.roots()
        XCTAssertEqual(result.map { $0.id }, ["a"])
        let calls = await counter.value
        XCTAssertEqual(calls, 1)
    }

    /// Disk cache present: the cache must return the primed value
    /// without first awaiting the fetcher. The fetcher may run in the
    /// background but the FIRST call returns the primed roots.
    func testDiskHit_ReturnsPrimedBeforeFetcherCompletes() async throws {
        let defaults = freshDefaults()
        let primed = [mkRoot("a"), mkRoot("b")]
        let data = try JSONEncoder().encode(primed)
        defaults.set(data, forKey: "fileprovider.default.library-roots")

        // Fetcher takes 200ms — far longer than the assertion below
        // will tolerate if the cache awaits it synchronously.
        let cache = LibraryRootCache(domainID: "default",
                                     defaults: defaults,
                                     fetcher: {
            try? await Task.sleep(nanoseconds: 200_000_000)
            return primed
        })
        let start = Date()
        let result = try await cache.roots()
        let elapsed = Date().timeIntervalSince(start)
        XCTAssertEqual(result.map { $0.id }, ["a", "b"])
        XCTAssertLessThan(elapsed, 0.1,
                          "roots() must return synchronously from disk cache")
    }

    /// After a successful fetch, the disk cache is written.
    func testPersistsToDiskAfterFetch() async throws {
        let defaults = freshDefaults()
        let cache = LibraryRootCache(domainID: "default",
                                     defaults: defaults,
                                     fetcher: { [self.mkRoot("a")] })
        _ = try await cache.roots()
        XCTAssertNotNil(defaults.data(forKey: "fileprovider.default.library-roots"))
    }

    /// `invalidate()` drops both the memory and the disk cache.
    func testInvalidateDropsDiskCache() async throws {
        let defaults = freshDefaults()
        let cache = LibraryRootCache(domainID: "default",
                                     defaults: defaults,
                                     fetcher: { [self.mkRoot("a")] })
        _ = try await cache.roots()
        XCTAssertNotNil(defaults.data(forKey: "fileprovider.default.library-roots"))
        await cache.invalidate()
        XCTAssertNil(defaults.data(forKey: "fileprovider.default.library-roots"))
    }

    /// CRITICAL: a fetcher that throws must not leave `inflight`
    /// permanently occupied. We assert the public observable: a
    /// second `roots()` call after a throw also reaches the fetcher
    /// (i.e. the fetcher is invoked twice, not just once with the
    /// second call quietly awaiting a dead Task).
    func testFetcherThrows_NextCallRetries() async throws {
        struct Boom: Error {}
        let defaults = freshDefaults()
        let counter = AsyncCounter()
        let cache = LibraryRootCache(domainID: "default",
                                     defaults: defaults,
                                     fetcher: {
            await counter.bump()
            throw Boom()
        })
        do {
            _ = try await cache.roots()
            XCTFail("expected first call to throw")
        } catch {}
        do {
            _ = try await cache.roots()
            XCTFail("expected second call to throw")
        } catch {}
        let calls = await counter.value
        XCTAssertEqual(calls, 2,
                       "fetcher must be invoked on each cold call after a throw")
    }

    /// CRITICAL: the drift handler must be wireable at construction
    /// time. The post-super.init Task installation shape that this
    /// fix replaces left a race window in which the first disk-primed
    /// `roots()` could land a revalidation BEFORE the handler was
    /// installed — drift would be silently lost. Constructing with the
    /// handler in-place must guarantee the very first revalidation
    /// signals.
    func testDriftHandlerFiresWhenInstalledAtInit() async throws {
        let defaults = freshDefaults()
        let priorRoots = [mkRoot("a", fileCount: 1)]
        let data = try JSONEncoder().encode(priorRoots)
        defaults.set(data, forKey: "fileprovider.default.library-roots")
        let freshRoots = [mkRoot("a", fileCount: 99)]
        let driftFired = AsyncFlag()
        // Pass the handler via init — NOT via setDriftHandler.
        let cache = LibraryRootCache(
            domainID: "default",
            defaults: defaults,
            driftHandler: { await driftFired.fire() },
            fetcher: { freshRoots }
        )
        let served = try await cache.roots()
        XCTAssertEqual(served, priorRoots)
        let ok = await driftFired.wait(timeout: 1.0)
        XCTAssertTrue(ok,
                      "drift handler installed at init must fire on first revalidation")
    }

    /// Revalidation that yields a list different from what was
    /// previously served fires the drift handler. A revalidation that
    /// matches does not.
    func testDriftHandlerFiresOnChangedRevalidation() async throws {
        let defaults = freshDefaults()
        // Prime disk with one value, configure the fetcher to return a
        // different list — the cache will serve the disk value first
        // and revalidate against the fetcher in the background.
        let priorRoots = [mkRoot("a", fileCount: 1)]
        let data = try JSONEncoder().encode(priorRoots)
        defaults.set(data, forKey: "fileprovider.default.library-roots")
        let freshRoots = [mkRoot("a", fileCount: 99)]
        let cache = LibraryRootCache(domainID: "default",
                                     defaults: defaults,
                                     fetcher: { freshRoots })
        let driftFired = AsyncFlag()
        await cache.setDriftHandler {
            await driftFired.fire()
        }
        let served = try await cache.roots()
        XCTAssertEqual(served, priorRoots)
        // Wait for the background revalidation to complete and fire.
        let ok = await driftFired.wait(timeout: 1.0)
        XCTAssertTrue(ok, "drift handler should fire when fresh list differs")
    }

    /// Smoke test for the kick-throw recovery path. After a primed
    /// read kicks a revalidation that throws, a subsequent primed read
    /// must kick a fresh revalidation, that one succeeds, the drift
    /// handler fires, and the memory cache updates to the new value.
    ///
    /// Note: the underlying race-window improvement (narrowing from
    /// deferred-Task clear to a single-actor-block clear via
    /// `finishRevalidation`) is sub-hop and not reliably discriminable
    /// from a sleep-based test — both the buggy and fixed code clear
    /// inflight within microseconds of the throw. What this test
    /// guards against is the catastrophic regression where inflight
    /// is never cleared at all, locking the cache up permanently.
    /// The window narrowing itself is verified by code review.
    func testPiggybackThrows_NextCallRetries() async throws {
        struct Boom: Error {}
        let defaults = freshDefaults()
        // Prime disk so roots() returns from disk and kicks
        // revalidation in the background — exercising the piggyback
        // path rather than the cold-runFetcher path.
        let priorRoots = [mkRoot("a")]
        let data = try JSONEncoder().encode(priorRoots)
        defaults.set(data, forKey: "fileprovider.default.library-roots")

        let freshRoots = [mkRoot("b")]
        let counter = AsyncCounter()
        let cache = LibraryRootCache(domainID: "default",
                                     defaults: defaults,
                                     fetcher: {
            await counter.bump()
            let n = await counter.value
            if n == 1 { throw Boom() }
            return freshRoots
        })
        let driftFired = AsyncFlag()
        await cache.setDriftHandler {
            await driftFired.fire()
        }

        // First read: returns from disk, kicks revalidation #1 (throws).
        let first = try await cache.roots()
        XCTAssertEqual(first, priorRoots)
        // Let revalidation #1 finish and finishRevalidation() run on
        // the actor, clearing inflight.
        try await Task.sleep(nanoseconds: 100_000_000)

        // Second read: returns from memory (still priorRoots), kicks
        // revalidation #2. If the bug were present, inflight would
        // still be non-nil and this kick would no-op forever.
        let second = try await cache.roots()
        XCTAssertEqual(second, priorRoots)

        // Wait for revalidation #2 to publish through the drift handler.
        let drifted = await driftFired.wait(timeout: 1.0)
        XCTAssertTrue(drifted,
                      "second kick must run, succeed, and signal drift")
        let calls = await counter.value
        XCTAssertEqual(calls, 2,
                       "fetcher must be invoked again after the previous kick threw")
    }

    /// CRITICAL: invalidate() must cancel/abandon any in-flight
    /// revalidation so a slow fetcher landing after invalidation cannot
    /// silently repopulate the cache the caller just emptied.
    func testInvalidateDuringInflightDoesNotRepopulate() async throws {
        let defaults = freshDefaults()
        // Prime disk so roots() returns immediately and kicks a slow
        // background revalidation.
        let priorRoots = [mkRoot("a")]
        let data = try JSONEncoder().encode(priorRoots)
        defaults.set(data, forKey: "fileprovider.default.library-roots")

        let freshRoots = [mkRoot("b"), mkRoot("c")]
        let cache = LibraryRootCache(
            domainID: "default",
            defaults: defaults,
            fetcher: {
                // Slow fetcher — gives the test room to invalidate
                // before this lands.
                try? await Task.sleep(nanoseconds: 200_000_000)
                return freshRoots
            }
        )
        // First read: returns from disk, kicks the slow revalidation.
        let served = try await cache.roots()
        XCTAssertEqual(served, priorRoots)
        // Invalidate immediately — captured generation in the kick is
        // now stale.
        await cache.invalidate()
        // Wait long enough that the in-flight fetcher would have
        // landed if generation-gating were absent.
        try await Task.sleep(nanoseconds: 400_000_000)
        // Cache must STILL be empty — neither the memory nor the disk
        // entry should have been silently repopulated.
        XCTAssertNil(defaults.data(forKey: "fileprovider.default.library-roots"))
        // And the next read (with a fast fetcher) must produce the
        // genuine new value, not the leaked stale fresh-roots.
        let nextRoots = [mkRoot("z")]
        let cache2 = LibraryRootCache(
            domainID: "default",
            defaults: defaults,
            fetcher: { nextRoots }
        )
        let nextServed = try await cache2.roots()
        XCTAssertEqual(nextServed, nextRoots)
    }

    func testDriftHandlerDoesNotFireOnUnchangedRevalidation() async throws {
        let defaults = freshDefaults()
        let roots = [mkRoot("a")]
        let data = try JSONEncoder().encode(roots)
        defaults.set(data, forKey: "fileprovider.default.library-roots")
        let cache = LibraryRootCache(domainID: "default",
                                     defaults: defaults,
                                     fetcher: { roots })
        let driftFired = AsyncFlag()
        await cache.setDriftHandler {
            await driftFired.fire()
        }
        _ = try await cache.roots()
        // Give the background revalidation room to complete.
        try await Task.sleep(nanoseconds: 200_000_000)
        let fired = await driftFired.didFire
        XCTAssertFalse(fired, "drift handler must not fire on matching revalidation")
    }
}

// MARK: - Test helpers

/// Tiny actor wrapper so multiple Tasks can bump a counter without
/// `nonisolated(unsafe)` shenanigans under Swift 6 strict concurrency.
private actor AsyncCounter {
    private(set) var value: Int = 0
    func bump() { value += 1 }
}

/// One-shot flag used to assert "did something async happen within
/// timeout T." Polls the actor at a 10ms cadence rather than parking
/// on a continuation — the previous TaskGroup-based shape left the
/// waiter continuation unresumed on timeout-driven cancellation, which
/// risked hanging when the harness aborted a test. A deadline-poll
/// loop is simpler and guarantees the call returns within `timeout`.
private actor AsyncFlag {
    private(set) var didFire: Bool = false

    func fire() {
        didFire = true
    }

    func wait(timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !didFire {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return true
    }
}
