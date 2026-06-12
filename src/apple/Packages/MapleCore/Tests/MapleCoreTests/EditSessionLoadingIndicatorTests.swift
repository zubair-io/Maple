// EditSessionLoadingIndicatorTests.swift — #1221 cold-open loading-indicator
// lifecycle, exercised against a REAL decode.
//
// The pure gate (`EditSession.shouldShowLoadingIndicator`) is covered by
// fast value tests in `EditSessionTests`. This file drives the genuine
// async pipeline so it catches lifecycle regressions the pure tests can't:
// the indicator flag (`isResolvingFirstFrame`) being set-but-never-cleared
// (a stuck spinner) or dropping before the first full-quality frame is on
// screen (the field-log bug this fixes — the old flag cleared the instant
// the decode FFI returned, mid-filter-chain).
//
// Fixture-gated: skips when `test-fixtures/raws/test_0002.dng` is absent
// (CI without the gitignored RAWs), mirroring the other RAW-backed tests.

import XCTest
import CoreImage
@testable import MapleCore

@MainActor
final class EditSessionLoadingIndicatorTests: XCTestCase {

    /// (a) starts false, (b) is held TRUE across the whole decode→first-frame
    /// window, and (c) clears once the first full-quality frame publishes —
    /// no stuck spinner.
    func testColdOpenLoadingIndicatorLifecycle() async throws {
        let fixturePath = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // MapleCore/
            .deletingLastPathComponent()  // Packages/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // <repo root>
            .appendingPathComponent("test-fixtures/raws/test_0002.dng")
        guard FileManager.default.fileExists(atPath: fixturePath.path) else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }

        let asset = AssetRef(url: fixturePath)
        let session = EditSession(asset: asset)
        await MainActor.run {
            session.previewSize = CGSize(width: 1500, height: 1000)
            session.pixelScale = 0  // fit
        }

        // (a) Before the open, the indicator is down.
        let initial = await session.isResolvingFirstFrame
        XCTAssertFalse(initial, "isResolvingFirstFrame must start false")

        session.ensureRenderStarted()

        // Poll the genuine async cold-open: record whether the flag is ever
        // observed TRUE (indicator up during the wait) and wait for the open to
        // settle into a published frame with the flag cleared.
        var observedResolving = false
        let deadline = Date().addingTimeInterval(30.0)
        while Date() < deadline {
            let resolving = await session.isResolvingFirstFrame
            if resolving { observedResolving = true }
            let preview = await session.renderedPreview
            let rendering = await session.isRendering
            if preview != nil && !rendering && !resolving { break }
            try await Task.sleep(for: .milliseconds(40))
        }

        let finalResolving = await session.isResolvingFirstFrame
        let finalPreview = await session.renderedPreview
        // (b) The indicator was actually up during the cold open.
        XCTAssertTrue(observedResolving,
            "isResolvingFirstFrame must be TRUE during the cold open — the loading indicator")
        XCTAssertNotNil(finalPreview, "cold open should publish a full-quality frame")
        // (c) …and it clears once that frame is on screen (no stuck spinner).
        XCTAssertFalse(finalResolving,
            "isResolvingFirstFrame must clear once the first full-quality frame publishes")
    }
}
