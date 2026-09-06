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
            asset: session.asset, model: session.model, layerIndex: session.scopeLayerIndex)

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

    /// Scoping to a layer must actually change the histogram (#3355).
    ///
    /// This is the assertion whose absence let the scope ship reading the
    /// whole frame forever: `scope_layer` worked in raw-ffi, the parameter
    /// was threaded all the way down, and Swift passed `-1` at every call
    /// site. Every test still passed, because none of them ever asked for a
    /// layer. Renders the SAME pixels twice — once whole-frame, once scoped
    /// to a half-frame mask — and compares the bins.
    func testScopingToALayerChangesTheHistogram() async throws {
        let url = try stagedPortrait()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }

        let session = await EditSession(asset: AssetRef(url: url))
        // A linear gradient across the frame: a mask that covers part of the
        // image, so the pixels it weighs are a real subset.
        let half = LocalAdjustment(
            mask: .linear(
                start: MaskPoint(x: 0, y: 0), end: MaskPoint(x: 1, y: 0), feather: 0.0),
            adjustments: PartialAdjustments(exposure: 0))
        session.model.localAdjustments = [half]

        let whole = try await EditSession.renderScopeSample(
            asset: session.asset, model: session.model, layerIndex: -1)
        let scoped = try await EditSession.renderScopeSample(
            asset: session.asset, model: session.model, layerIndex: 0)

        XCTAssertGreaterThan(whole.total, 0, "whole-frame scope must have weight")
        XCTAssertGreaterThan(scoped.total, 0, "layer-scoped scope must have weight")
        XCTAssertNotEqual(
            whole.bins, scoped.bins,
            "scoping to a layer must change the histogram — identical bins mean the "
                + "layer index never reached raw-ffi (#3355)")
        XCTAssertLessThan(
            scoped.total, whole.total,
            "a mask covering part of the frame must weigh less than the whole frame")
    }

    /// The PRODUCER must pass the selection through — not just raw-ffi
    /// honour it (#3355).
    ///
    /// `testScopingToALayerChangesTheHistogram` above calls
    /// `renderScopeSample` with an explicit index, so it proves raw-ffi's
    /// weighting works while saying nothing about the wiring in between —
    /// and the wiring is exactly what was broken: both producers hardcoded
    /// `-1`. This drives the real debounced path with a layer SELECTED and
    /// checks the published sample is the scoped one.
    func testProducerPublishesTheSelectedLayersScope() async throws {
        let url = try stagedPortrait()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }

        let session = await EditSession(asset: AssetRef(url: url))
        let half = LocalAdjustment(
            mask: .linear(
                start: MaskPoint(x: 0, y: 0), end: MaskPoint(x: 1, y: 0), feather: 0.0),
            adjustments: PartialAdjustments(exposure: 0))
        session.model.localAdjustments = [half]
        session.selectedMaskId = half.id
        session.scopeEnabled = true

        session.scheduleScopeCpuUpdate()
        // Debounce plus the compute itself.
        try await Task.sleep(for: .milliseconds(2500))

        let published = try XCTUnwrap(session.scopeSample, "producer published no sample")
        let wholeFrame = try await EditSession.renderScopeSample(
            asset: session.asset, model: session.model, layerIndex: -1)

        XCTAssertNotEqual(
            published.bins, wholeFrame.bins,
            "the published sample matches the WHOLE FRAME — the producer ignored the "
                + "selection and passed -1 (#3355)")
    }
}
