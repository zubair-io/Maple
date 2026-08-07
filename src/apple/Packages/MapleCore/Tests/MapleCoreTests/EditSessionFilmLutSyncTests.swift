// EditSessionFilmLutSyncTests.swift — the ordering fix for film-look
// session sync (epic #2683, Task 10 fix round 1).
//
// The original design pushed the resolved lattice from `model`'s `didSet`
// via an unstructured `Task` while the SAME `didSet` scheduled the next
// render synchronously right after — nothing enforced the push landed
// before the render reached the FFI. The fix moved the push into
// `EditSession.syncFilmLutForPresent(driver:)`, called from
// `presentViaGpuLive` BEFORE it presents (mirroring
// `fitAutoProfileIfNeeded`) — sequential statements in one `async`
// function, not two independent tasks racing each other.
//
// `presentViaGpuLive` itself needs a real `CAMetalLayer`/Metal device, so
// it can't run in a plain unit test — but `syncFilmLutForPresent` is the
// exact seam the ordering guarantee lives in, and it needs neither: it
// only touches `model.filmLook`, `filmLutStore` (now injectable via
// `EditSession.init`), and `GpuLiveDriver`'s film-lut cache (which itself
// works with no open `GpuLiveSession` — see `GpuLiveDriverReuseTests`'
// header for the same "driver is Metal-free, the session isn't" split).
//
// The assertion that matters: by the time `await syncFilmLutForPresent(...)`
// RETURNS, `driver.currentFilmLutKey` already matches the resolved lattice
// — i.e. there is no `await` gap left between "the model says this look"
// and "the session holds this look" for a caller (`presentViaGpuLive`) that
// sequences its present call after this one, synchronously, in the same
// function body.

import XCTest
@testable import MapleCore

@MainActor
final class EditSessionFilmLutSyncTests: XCTestCase {

    /// A session whose `model.filmLook` is set AT CONSTRUCTION (an `init`
    /// parameter, not a post-init mutation) — `model`'s `didSet` does not
    /// fire for the value an initializer assigns to its own property, so
    /// this builds a session with the desired starting look with no render/
    /// sidecar side effects to work around.
    private func makeSession(filmLook: String) -> EditSession {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        var model = AdjustmentModel.default
        model.filmLook = filmLook
        return EditSession(
            asset: AssetRef(url: url),
            model: model,
            filmLutStore: FilmLutStore(bundle: .module)
        )
    }

    /// A session resolving to a KNOWN good look: after `syncFilmLutForPresent`
    /// returns, the driver's cached key already matches the fixture's
    /// FNV-1a(id) — the positive case of the ordering guarantee.
    func testSyncPushesTheResolvedLatticeBeforeReturning() async {
        let session = makeSession(filmLook: "test_lut")
        let driver = GpuLiveDriver()
        XCTAssertNil(driver.currentFilmLutKey, "a fresh driver starts with no film look")

        await session.syncFilmLutForPresent(driver: driver)

        let expectedKey = FilmLutStore.fnv1aHash("test_lut")
        XCTAssertEqual(
            driver.currentFilmLutKey, expectedKey,
            "the driver must hold the resolved lattice's key the instant sync returns — this is what makes presentViaGpuLive's subsequent present() safe to call without racing the push")
    }

    /// A session with NO look configured: sync must leave (or put) the
    /// driver at "no look" — the identity fallback, same postcondition
    /// discipline as the positive case above.
    func testSyncClearsWhenModelHasNoFilmLook() async {
        let session = makeSession(filmLook: "")
        let driver = GpuLiveDriver()

        await session.syncFilmLutForPresent(driver: driver)

        XCTAssertNil(driver.currentFilmLutKey)
    }

    /// A session whose look does not resolve (no matching `.mlut`): sync
    /// must clear the driver's film state rather than leave it holding a
    /// stale key — the render falls back to identity instead of a wrong
    /// look, mirroring `AutoProfileLUT`'s "render plain" contract.
    func testSyncClearsWhenLookDoesNotResolve() async {
        let session = makeSession(filmLook: "does_not_exist_in_the_catalog")
        let driver = GpuLiveDriver()

        await session.syncFilmLutForPresent(driver: driver)

        XCTAssertNil(driver.currentFilmLutKey)
    }

    /// Switching FROM a resolved look TO no look, on the SAME driver
    /// (simulating consecutive presents across a look change): the second
    /// sync must actually clear the first sync's push, not leave the
    /// stale key behind because of the `currentFilmLutKey` fast-path
    /// short-circuit misfiring.
    func testSwitchingAwayFromALookClearsThePreviousPush() async {
        let driver = GpuLiveDriver()
        await session(withFilmLook: "test_lut").syncFilmLutForPresent(driver: driver)
        XCTAssertNotNil(driver.currentFilmLutKey)

        await session(withFilmLook: "").syncFilmLutForPresent(driver: driver)
        XCTAssertNil(driver.currentFilmLutKey, "a switch to no look must clear the driver's stale key from the prior sync")
    }

    /// A second sync for the SAME already-loaded look must be a fast-path
    /// no-op (the whole point of the `currentFilmLutKey` comparison) —
    /// asserted indirectly: it must still leave the driver holding the
    /// correct key (the fast path must not accidentally clear it).
    func testRepeatSyncForTheSameLookStaysCorrect() async {
        let driver = GpuLiveDriver()
        let session = makeSession(filmLook: "test_lut")
        await session.syncFilmLutForPresent(driver: driver)
        await session.syncFilmLutForPresent(driver: driver)
        XCTAssertEqual(driver.currentFilmLutKey, FilmLutStore.fnv1aHash("test_lut"))
    }

    private func session(withFilmLook filmLook: String) -> EditSession {
        makeSession(filmLook: filmLook)
    }
}
