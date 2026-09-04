// ScopeCpuProducerTests.swift — end-to-end coverage for the CPU / non-GPU-live
// scope producer (#3277).
//
// Everything else in this area is either a pure-math unit test
// (ScopeSampleTests, ScopeSampleCentroidTests) or a mocked call-assertion,
// so nothing so far actually pushes real pixels through
// `EditSession+ScopeCpu.swift` -> `PipelineRenderer
// .applyChainAndEncodeDisplayScoped` -> `maple_apply_chain_and_encode_
// display_scoped_f32` -> `MapleScopeStats`'s caller-owned bins buffer. This
// does, using the bundled portrait fixture: a NON-RAW asset, which is
// exactly the case that can never be served by the GPU-live path and so
// depends on this fallback.

import CoreGraphics
import XCTest

@testable import MapleCore

@MainActor
final class ScopeCpuProducerTests: XCTestCase {
    /// Stages the bundled portrait PNG into a temp dir and returns its URL —
    /// `AssetRef` wants a file on disk, and the bundle resource is read-only.
    private func stagedPortrait() throws -> URL {
        guard let src = Bundle.module.url(forResource: "portrait-skin-test", withExtension: "png")
        else {
            throw XCTSkip("portrait-skin-test.png fixture missing from the test bundle")
        }
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("scope-cpu-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dst = dir.appendingPathComponent("portrait-skin-test.png")
        try FileManager.default.copyItem(at: src, to: dst)
        return dst
    }

    func testCpuProducerBuildsAScopeSampleFromRealPixels() async throws {
        let url = try stagedPortrait()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }

        let session = await EditSession(asset: AssetRef(url: url))
        XCTAssertFalse(session.asset.isRaw, "fixture must exercise the non-RAW fallback path")
        XCTAssertNil(session.scopeSample, "no sample before the producer runs")

        // Arm the HUD, which is what gates the producer, then run one compute
        // directly rather than waiting out the 350 ms debounce.
        session.scopeEnabled = true
        let sample = try await EditSession.renderScopeSample(
            asset: session.asset, model: session.model)

        // A real photograph must land actual weight in the histogram.
        XCTAssertGreaterThan(sample.total, 0, "a real image should produce non-zero scope weight")
        XCTAssertEqual(sample.bins.count, 128)
        XCTAssertEqual(sample.bins[0].count, 128)

        // The bins are the same fixed-point weight `total` is summed in, so
        // they must agree — this is what proves the caller-owned bins buffer
        // (#3277's MapleScopeStats redesign) was actually written through by
        // Rust, rather than silently left zeroed.
        let binned = sample.bins.reduce(into: UInt64(0)) { acc, row in
            acc += row.reduce(into: UInt64(0)) { $0 += UInt64($1) }
        }
        XCTAssertEqual(binned, UInt64(sample.total), "bins must sum to total")

        // Chroma mass must not sit entirely in one bin — that would mean the
        // Cb/Cr projection collapsed rather than spreading a real image.
        let occupied = sample.bins.reduce(into: 0) { acc, row in
            acc += row.reduce(into: 0) { $0 += ($1 > 0 ? 1 : 0) }
        }
        XCTAssertGreaterThan(occupied, 1, "a photograph should occupy more than one chroma bin")

        // And a skin-bearing portrait should have a meaningful centroid.
        let centroid = try XCTUnwrap(sample.centroidAngleDeg)
        XCTAssertTrue(centroid.isFinite)
    }
}
