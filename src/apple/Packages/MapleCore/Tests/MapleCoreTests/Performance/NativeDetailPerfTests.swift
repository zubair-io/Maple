// NativeDetailPerfTests.swift — native-detail 1:1-zoom develop perf bench (#2114).
//
// Why this exists:
//
//   At 100% zoom (`pixelScale >= 1`) the Apple canvas leaves the sized
//   whole-image decode and refines the visible region through
//   `NativeDetailRenderer.render` → the Rust TILE develop path
//   (`maple_render_handle_scene_linear_tile_ae_f32`). That path is the
//   load-bearing cost of a 1:1 zoom / pan, and it had NO automated perf
//   coverage — the existing slider benches drive `processSceneLinear` (the
//   whole-image chain), never the tile develop.
//
//   The 100MP color reference `test_0000.DNG` / `dji-mavic3pro-100mp.dng`
//   (Hasselblad L3D-100c) can't cover it: it carries an OpcodeList3
//   (GainMap / WarpRectilinear), which the tile path refuses (#1932), so a
//   1:1 zoom on it falls back to the whole-image render and the tile develop
//   never runs. See docs/superpowers/perf/2026-07-19-100mp-instrument-pass.md
//   §3 ("100% zoom / native-detail patch — GAP on this fixture").
//
//   This bench develops a viewport-sized 1:1 patch of a SYNTHETIC ~100MP
//   fixture that carries NO OpcodeList3, so the tile path actually runs and
//   the develop is measurable at the reference scale.
//
// The fixture:
//
//   `test-fixtures/raws/synthetic-100mp-noopcode.dng` — 12288×8192 (100.7 MP,
//   the L3D-100c scale), real Hasselblad dual-illuminant DCP matrices, a
//   deterministic textured Bayer strip, and NO OpcodeList3. It is gitignored
//   (fixtures never commit), so the committed artifact is its GENERATOR:
//
//     cargo run --release -p raw-core --features test-support \
//       --example gen-synthetic-dng -- \
//       --out test-fixtures/raws/synthetic-100mp-noopcode.dng
//
//   When the fixture is absent (CI without fixtures), the bench XCTSkips —
//   the same soft-pass contract the slider benches use.
//
// How to run:
//
//   MAPLE_PERF=1 swift test --filter NativeDetailPerf
//
// Reporting / gate:
//
//   Prints a one-line stderr summary with mean / p50 / p95 / max in ms for the
//   tile develop, plus the developed patch size. The hard assertion is a
//   LOOSE interim ceiling (see `interimHardLimitMs`) — this is a brand-new
//   bench with no prior baseline, so per the one-way-ratchet policy the
//   ceiling is set generously above the measured mean and only ever ratchets
//   DOWN. The bench also asserts the tile path was actually exercised (the
//   returned patch matches the requested develop rect) — i.e. it did NOT hit
//   the OpcodeList3 bail and fall back, which is the entire point of the
//   fixture.
//
// Cross-references:
//   src/apple/Packages/MapleCore/Sources/MapleCore/NativeDetailRenderer.swift
//   src/apple/Packages/MapleCore/Sources/MapleCore/EditSession+NativeDetail.swift
//   src/raw-pipeline/raw-core/src/test_support/synth_perf.rs
//   docs/superpowers/perf/2026-07-19-100mp-instrument-pass.md §3

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

final class NativeDetailPerfTests: XCTestCase {

    // MARK: - Configuration

    /// Number of timed 1:1 develops after the warm-up (which opens + decodes
    /// the RAW handle). Fewer than the slider benches' 50 because each develop
    /// is a full-quality ~4.5 MP tile, not a viewport-scaled chain tick.
    private static let developCount = 12

    /// The ENFORCED interim ceiling for one native-detail 1:1 develop, in ms.
    ///
    /// Brand-new bench, no prior baseline (the #2114 fixture is the first that
    /// can measure this path at 100MP scale). Measured on an Apple M-series
    /// (developing a 2592×1752 patch of the synthetic 100MP fixture at
    /// `RenderQuality.full`, 12 develops after warm-up): mean ≈ 33.7 ms
    /// (p50 31.4, p95 / max 52.9). Per the one-way-ratchet policy the ceiling
    /// is set GENEROUSLY above that — ≈ 3.5× the measured mean, ≈ 2.3× the
    /// observed max — so it does not flake on slower dev machines (project
    /// history notes ~1.6× slower boxes) or under concurrent load, and it only
    /// ever ratchets DOWN as the tile develop tightens. The assertion is on
    /// the MEAN. It is not a spec target; it is a regression backstop.
    private static let interimHardLimitMs: Double = 120.0

    /// Viewport the 100% zoom fills — the same 1920×1080 floor the slider
    /// benches use. The developed patch grows this by `NativeDetailLOD`'s
    /// pan-reuse margin + filter halo, exactly as the live session does.
    private static let viewportSize = CGSize(width: 1920, height: 1080)

    /// Auto's decode contract disables auto-exposure, so its exported
    /// `MapleSceneLinearImageData.aeGain` is always 1.0 — the value the live
    /// session threads into the tile for an Auto-profile image. Native-detail
    /// is gated to RAW + Auto, so 1.0 is the correct (and only) AE anchor here.
    private static let autoAEGain: Float = 1.0

    // MARK: - Fixture discovery

    /// Resolve the non-OpcodeList3 synthetic 100MP fixture. Mirrors
    /// `SliderTickPerfHarness.resolveFixture`'s primary + worktree-fallback
    /// climb, but for THIS bench's dedicated fixture only — the slider benches'
    /// candidates (`dji-mavic3pro-100mp.dng`) carry OpcodeList3 and would hit
    /// the tile bail, so they are deliberately NOT accepted here.
    private static func resolveFixture() -> URL? {
        let name = "synthetic-100mp-noopcode.dng"
        let fm = FileManager.default
        let root = SliderTickPerfHarness.repoRoot()

        let primary = root
            .appendingPathComponent("test-fixtures/raws")
            .appendingPathComponent(name)
        if fm.fileExists(atPath: primary.path) { return primary }

        // Worktree fallback — climb `.claude/worktrees/<id>` to the host repo.
        let host = root
            .deletingLastPathComponent()  // worktrees
            .deletingLastPathComponent()  // .claude
            .deletingLastPathComponent()  // host repo
            .appendingPathComponent("test-fixtures/raws")
            .appendingPathComponent(name)
        if fm.fileExists(atPath: host.path) { return host }

        return nil
    }

    // MARK: - Test entry

    func testNativeDetail1to1DevelopPerf() async throws {
        guard ProcessInfo.processInfo.environment["MAPLE_PERF"] == "1" else {
            throw XCTSkip(
                "Set MAPLE_PERF=1 to run perf benches " +
                "(default `swift test` runs skip the slow harness)."
            )
        }
        guard let fixtureURL = Self.resolveFixture() else {
            throw XCTSkip(
                "No non-OpcodeList3 100MP fixture — looked for " +
                "test-fixtures/raws/synthetic-100mp-noopcode.dng. Generate it " +
                "with `cargo run --release -p raw-core --features test-support " +
                "--example gen-synthetic-dng -- --out " +
                "test-fixtures/raws/synthetic-100mp-noopcode.dng`. CI without " +
                "fixtures skip-passes."
            )
        }

        // 1. Native-detail requires RAW + Auto (the whole-image path the tile
        //    reproduces disables AE only under Auto). Build a default Auto
        //    model and a session-scoped renderer, exactly like the live
        //    `EditSession.refineNativeDetail`.
        var model = AdjustmentModel.default
        model.profile = .auto
        let asset = AssetRef(url: fixtureURL)
        let renderer = NativeDetailRenderer()

        // 2. Simulate a 100% zoom: a 1920×1080 viewport centred in the
        //    12288×8192 image. The develop rect the live session sends to the
        //    tile entry is the viewport grown by the pan-reuse margin
        //    (`patchRect`) plus the filter halo (`decodeRect`) — reproduce
        //    that here so the measured cost matches a real 1:1 refine.
        let imageSize = CGSize(width: 12288, height: 8192)
        let viewport = CGRect(
            x: (imageSize.width - Self.viewportSize.width) / 2,
            y: (imageSize.height - Self.viewportSize.height) / 2,
            width: Self.viewportSize.width,
            height: Self.viewportSize.height
        )
        XCTAssertTrue(
            NativeDetailLOD.shouldRender(pixelScale: 1, visibleRect: viewport),
            "viewport must satisfy the 100%-zoom native-detail gate"
        )
        let patchRect = NativeDetailLOD.patchRect(
            visibleRect: viewport, imageSize: imageSize
        )
        let developRect = NativeDetailLOD.decodeRect(
            detailRect: patchRect, imageSize: imageSize
        )
        XCTAssertFalse(developRect.isEmpty, "develop rect must be non-empty")

        // 3. Warm-up: opens the RAW handle (decode + strip, a one-time
        //    session-open cost the live editor already absorbs) AND runs one
        //    develop. This is ALSO the "not-fallback" proof: if the fixture
        //    carried OpcodeList3, `render` would throw `renderFailed(code: 10)`
        //    here and the develop below would never run. The returned patch
        //    dimensions must match the requested develop rect — i.e. the tile
        //    path produced the patch, it did not silently fall back.
        let warm: CIImage
        do {
            warm = try await renderer.render(
                asset: asset,
                sourceRect: developRect,
                model: model,
                aeGain: Self.autoAEGain
            )
        } catch {
            XCTFail(
                "native-detail tile develop threw on the synthetic fixture — " +
                "the fixture is supposed to carry NO OpcodeList3 so the tile " +
                "path runs. Error: \(error)"
            )
            return
        }
        XCTAssertEqual(
            warm.extent.width, developRect.width, accuracy: 1.0,
            "developed patch width must match the requested tile rect " +
            "(native-detail path ran, not the whole-image fallback)"
        )
        XCTAssertEqual(
            warm.extent.height, developRect.height, accuracy: 1.0,
            "developed patch height must match the requested tile rect " +
            "(native-detail path ran, not the whole-image fallback)"
        )

        // 4. Timed develops. The renderer caches the RAW handle across calls
        //    with the same key, so each timed call skips the open and runs
        //    only the tile develop — exactly what a pan at 100% pays per
        //    settle. Shift the origin a few px per iteration (keeping the
        //    develop SIZE constant) so no positional memoisation can shortcut
        //    the work, mirroring a small pan.
        let maxShift = 32
        var samples: [Double] = []
        samples.reserveCapacity(Self.developCount)
        for i in 0..<Self.developCount {
            let shift = CGFloat(i % maxShift)
            let shifted = CGRect(
                x: developRect.minX + shift,
                y: developRect.minY + shift,
                width: developRect.width,
                height: developRect.height
            ).intersection(CGRect(origin: .zero, size: imageSize))
            let start = ContinuousClock.now
            let patch = try await renderer.render(
                asset: asset,
                sourceRect: shifted,
                model: model,
                aeGain: Self.autoAEGain
            )
            let end = ContinuousClock.now
            // Touch the result so the develop isn't optimised away.
            XCTAssertFalse(patch.extent.isEmpty)
            samples.append(SliderTickPerfHarness.elapsedMs(from: start, to: end))
        }

        // 5. Stats + report.
        let sorted = samples.sorted()
        let mean = samples.reduce(0, +) / Double(samples.count)
        let p50 = sorted[sorted.count / 2]
        let p95 = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
        let maxMs = sorted.last ?? 0

        let summary = String(
            format: "[native-detail-perf] fixture=%@ develops=%d " +
                    "patch=%dx%d mean=%.2fms p50=%.2fms p95=%.2fms max=%.2fms " +
                    "spec(target=%.0fms hard=%.0fms) interim-hard=%.0fms",
            fixtureURL.lastPathComponent,
            Self.developCount,
            Int(developRect.width), Int(developRect.height),
            mean, p50, p95, maxMs,
            SliderTickPerfHarness.specTargetMs,
            SliderTickPerfHarness.specHardLimitMs,
            Self.interimHardLimitMs
        )
        FileHandle.standardError.write(Data((summary + "\n").utf8))

        // 6. Loose interim ceiling (machine-dependent regression backstop —
        //    ratchets DOWN only). Not the spec target; the tile develop floor
        //    is well above 16/50 ms and driving it down is separate work.
        let meanText = String(format: "%.2f", mean)
        let ceilingText = String(format: "%.0f", Self.interimHardLimitMs)
        XCTAssertLessThan(
            mean, Self.interimHardLimitMs,
            "Mean native-detail 1:1 develop \(meanText) ms exceeds the " +
            "\(ceilingText) ms interim ceiling. Either a real tile-develop " +
            "regression, or the fixture/hardware changed — investigate " +
            "NativeDetailRenderer.render → renderTileF32 " +
            "(maple_render_handle_scene_linear_tile_ae_f32) before relaxing " +
            "the ceiling (one-way ratchet: it only goes down)."
        )
    }
}
