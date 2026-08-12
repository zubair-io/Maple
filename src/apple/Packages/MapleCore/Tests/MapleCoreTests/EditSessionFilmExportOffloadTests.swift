// EditSessionFilmExportOffloadTests.swift — pins the film-look export
// render OFF the main actor (epic #2683, bugfix round 2).
//
// `EditSession.renderExportWithFilmLook()` is `@MainActor` — it used to
// call `PipelineRenderer.render(rawPath:xmpPath:quality:filmLut:)`
// synchronously right there, a full RAW decode→develop→render running
// directly on the main actor's serial executor and freezing the UI for the
// duration of an export. The fix moves the heavy call behind
// `RenderActor.renderExportWithFilmLook(...)` (`RenderActor+Export.swift`),
// mirroring the sibling `renderForExport` path, which already offloads its
// heavy work off `@MainActor`.
//
// `PipelineRenderer` is a stateless struct around the FFI with no seam to
// inject a fake render function, so option (a) from the review ("assert the
// RenderActor method is the path taken via a spy") isn't available without
// adding test-only indirection the rest of the codebase doesn't have. This
// is option (b): an isolation-level test. It runs a REAL fixture render
// (heavy enough to take a non-trivial amount of wall time) concurrently
// with a `@MainActor` heartbeat task and asserts the heartbeat's max gap
// stays small. If the render call regresses back onto `@MainActor`
// (synchronous, as it was before this fix), the main actor's serial
// executor is occupied by that one call for the full render duration, and
// the heartbeat — itself `@MainActor` — cannot run a single iteration until
// the render returns, so its max gap collapses to ~the whole render
// duration and the assertion fails.
//
// Fixture-gated: skips (does not fail) when the RAW fixture is absent —
// mirrors every other perceptual/fixture-gated test in this repo.

import XCTest
@testable import MapleCore

@MainActor
final class EditSessionFilmExportOffloadTests: XCTestCase {

    private static func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private static func fixtureRawURL() -> URL {
        let primary = repoRoot().appendingPathComponent("test-fixtures/raws/test_0005.RAF")
        if FileManager.default.fileExists(atPath: primary.path) { return primary }
        return repoRoot().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("test-fixtures/raws/test_0005.RAF")
    }

    /// The main-actor heartbeat: ticks a counter as fast as the scheduler
    /// will allow, recording the largest gap between consecutive ticks.
    /// A healthy (non-blocked) main actor keeps this gap on the order of a
    /// few milliseconds even while another Task does heavy work elsewhere;
    /// a main actor occupied by a synchronous heavy call cannot service
    /// this task AT ALL until the call returns, so the gap balloons to
    /// roughly the full duration of that call.
    private final class Heartbeat {
        private(set) var maxGap: TimeInterval = 0
        private var last = Date()

        @MainActor
        func run() async {
            last = Date()
            while !Task.isCancelled {
                let now = Date()
                maxGap = max(maxGap, now.timeIntervalSince(last))
                last = now
                try? await Task.sleep(nanoseconds: 2_000_000)  // 2ms cadence
            }
        }
    }

    func testFilmLookExportRenderDoesNotBlockTheMainActor() async throws {
        let rawURL = Self.fixtureRawURL()
        guard FileManager.default.fileExists(atPath: rawURL.path) else {
            throw XCTSkip("test_0005.RAF absent — fixture-gated")
        }

        var model = AdjustmentModel.default
        model.filmLook = "test_lut"
        let session = EditSession(
            asset: AssetRef(url: rawURL),
            model: model,
            filmLutStore: FilmLutStore(bundle: .module)
        )

        let heartbeat = Heartbeat()
        let heartbeatTask = Task { @MainActor in await heartbeat.run() }
        // Yield once so the heartbeat task actually starts ticking before
        // the render kicks off, rather than racing task startup.
        await Task.yield()

        let renderStart = Date()
        let image = try await session.renderForExport()
        let renderDuration = Date().timeIntervalSince(renderStart)

        heartbeatTask.cancel()
        _ = await heartbeatTask.value

        XCTAssertNotNil(image, "film-look export must still produce a rendered image")
        // Sanity check the render was genuinely heavy enough for this test
        // to mean anything — a near-instant render couldn't distinguish
        // "offloaded" from "blocking" (both would show a small max gap).
        XCTAssertGreaterThan(
            renderDuration, 0.05,
            "expected a full RAW decode→develop→render to take more than 50ms — the render finished too fast for this isolation check to be meaningful; re-verify the fixture/quality path")
        XCTAssertLessThan(
            heartbeat.maxGap, renderDuration / 2,
            "the main-actor heartbeat stalled for a large fraction of the film-look export render (\(heartbeat.maxGap)s of \(renderDuration)s) — this means the heavy PipelineRenderer.render(...) call is running ON the main actor again instead of being offloaded to RenderActor")
    }
}
