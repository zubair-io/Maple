// AutoProfileResidualParityTests924.swift — #924.
//
// The #924 residual-LUT additions to the Auto Profile cube, split out of
// AutoProfileCanvasParityTests.swift for the file-size budget. An extension of
// the same class so it reuses the helpers there (renderApple, perBandBias,
// resampleNearest, fixtureDir) — same pattern as AutoProfileAEOffDecodeTests871.

import CoreImage
import RawPipeline
import XCTest
@testable import MapleCore

extension AutoProfileCanvasParityTests {


    /// COMMITTED GATE, fixture-free, <1s. Proves the new one-shot composed FFI
    /// (`maple_compute_auto_profile_lut`) symbol links and its error / argument-
    /// validation paths behave, without needing a RAW (the residual fit needs a
    /// real embedded JPEG, so the full compose can only be gated under fixtures
    /// — see `testAutoProfileMatchesCPUFullAuto`). A nonexistent RAW path must
    /// fail (nonzero rc → the host renders plain AgX), and an out-of-range cube
    /// edge must be rejected BEFORE the multi-second develop.
    func testComposedAutoLUTLinksAndDegradesOnBadPath() throws {
        let n = Self.lutSize
        var lut = [Float](repeating: -1, count: n * n * n * 3)
        let bogus = NSTemporaryDirectory() + "maple-no-such-\(UUID().uuidString).dng"

        let rcMissing = bogus.withCString { cpath -> Int32 in
            lut.withUnsafeMutableBufferPointer { lbuf in
                maple_compute_auto_profile_lut(cpath, nil, 0, UInt32(n), lbuf.baseAddress)
            }
        }
        XCTAssertNotEqual(rcMissing, 0, "a nonexistent RAW must not yield rc=0 (success)")

        // n < 2 is rejected with -1 up front (fail-fast, before any develop).
        let rcBadN = bogus.withCString { cpath -> Int32 in
            lut.withUnsafeMutableBufferPointer { lbuf in
                maple_compute_auto_profile_lut(cpath, nil, 0, 1, lbuf.baseAddress)
            }
        }
        XCTAssertEqual(rcBadN, -1, "n < 2 must be rejected with -1")
    }

    // MARK: - (4) Apple Auto canvas == CPU full Auto (fixture-gated, #924)
    //
    // The residual reaches the canvas ONLY through a real embedded JPEG, so no
    // fixture-free test can prove the composition lands on screen (the #894
    // lesson: gate Apple paths with REAL fixtures, not synthetic cubes). This
    // gate renders the Apple Auto canvas (composed curve∘residual cube) and the
    // CPU full pipeline (`maple_render_file` = `maple-cli render --profile auto`,
    // which applies the SAME curve + residual via `apply_auto_profile`) from the
    // same dylib, and gates the per-luma-band per-channel signed bias between
    // them. Aggregate ΔE/RMSE are banned (#530). Skips per-fixture when the
    // gitignored RAW is absent (CI), mirroring `test_color_pipeline.sh`.

    /// Widen a packed RGB u8 buffer (3 B/px, the `MapleImageData` layout) to
    /// RGBA (4 B/px, alpha 255) so it can feed `perBandBias` / `resampleNearest`,
    /// which assume the canvas's 4-byte stride.
    static func rgbToRGBA(_ rgb: [UInt8]) -> [UInt8] {
        let n = rgb.count / 3
        var out = [UInt8](repeating: 255, count: n * 4)
        for i in 0..<n {
            out[i * 4 + 0] = rgb[i * 3 + 0]
            out[i * 4 + 1] = rgb[i * 3 + 1]
            out[i * 4 + 2] = rgb[i * 3 + 2]
        }
        return out
    }

    /// Per-band per-channel signed-bias ceilings, one-way ratchet (#530): lower
    /// only alongside an improvement. Measured on test_0006 / test_0007 (DNG)
    /// with As-Shot WB matched across engines and AgX + the rec2020→sRGB encode
    /// shared via FFI, so the cross-engine floor is ~0 and `autoVsCpu` is
    /// effectively a delta-of-deltas gate on the Auto tail.
    ///
    /// `neutralFloor` — Apple Neutral vs CPU Neutral, NO Auto tail; guards the
    /// decode/WB/encode match (a WB or decode regression balloons it). Observed
    /// ≤ 0.0056 on test_0006 / test_0007 (the fixtures the budget was tuned on).
    /// `autoVsCpu` — Apple composed cube vs CPU full Auto (#550 curve + residual
    /// via apply_auto_profile). Observed ≤ 0.0104 (darkest band, where the
    /// residual + trilinear gap is largest). A broken compose / wrong sample
    /// domain inflates it well past ceiling — the regression this gate catches.
    private static let neutralFloorBandBiasBudget = 0.012
    private static let autoVsCpuBandBiasBudget = 0.018

    /// Per-fixture neutral-floor exception for `test_0002.dng` (Hasselblad
    /// H5D-40), and ONLY in its BRIGHTEST luma band (0.75–1.001).
    ///
    /// That band holds an inherent +0.0229 B-channel floor (R≈+0.009, G≈−0.004)
    /// over ~4242 extreme-highlight pixels. This is NOT a regression: it is
    /// bit-identical (0.022942378271440547) at HEAD and at the pre-#1337 parent
    /// `5867ff8a5`, and `maple_render_file` (the cpuNeutral reference) is
    /// byte-stable across that whole window — i.e. none of the recent raw-gpu /
    /// #1337 / #1341 / local-adjustment changes moved it. The gap is the
    /// dual-engine difference on this frame's wide-gamut blue highlights: Apple
    /// renders Neutral as Rust decode → a CoreImage f32 materialise through the
    /// `extendedLinearSRGB` working space → `apply_scene_linear_chain_f32` (AgX)
    /// → `rec2020_to_srgb`, whereas the reference is a single `maple_render_file`
    /// pass; AgX's steep shoulder amplifies the brightest-highlight delta.
    ///
    /// The budget above was measured on test_0006 / test_0007 only; test_0002
    /// was never validated against it (historically skipped — no native embedded
    /// preview / fixture absent at tuning time), so this is a FIRST-TIME
    /// per-fixture ceiling set ~9 % above the observed floor — it does NOT relax
    /// the 0006/0007 budget (one-way ratchet preserved). Every OTHER band of
    /// test_0002 stays at the tight 0.012, so a uniform WB/decode regression
    /// (which moves all bands) is still caught here; and the PRIMARY auto-tail
    /// gate (b) still holds for test_0002 (≤ 0.0059 ≪ 0.018).
    private static let test0002HighlightFloorBudget = 0.025

    /// Neutral-floor ceiling for a given fixture + luma band. Everything is the
    /// tight `neutralFloorBandBiasBudget` except test_0002.dng's brightest band
    /// (`lo == 0.75`) — see `test0002HighlightFloorBudget`. The equality match
    /// pins the exception to exactly the `(0.75, 1.001)` band `perBandBias`
    /// emits today; if the band edges are ever re-split, this fails closed (the
    /// new sub-bands fall back to the tight budget) rather than silently
    /// inheriting the loose one — forcing the exception to be re-justified.
    private static func neutralFloorBudget(fixture: String, bandLo: Double) -> Double {
        if fixture == "test_0002.dng" && bandLo == 0.75 {
            return test0002HighlightFloorBudget
        }
        return neutralFloorBandBiasBudget
    }



    func testAutoProfileMatchesCPUFullAuto() async throws {
        // DNG fixtures whose embedded preview rawler extracts NATIVELY. The
        // Apple app can't shell out to exiftool (sandbox; absent on iOS), so the
        // Auto tail only reaches the canvas for natively-extractable previews —
        // a fixture whose cube can't build is skipped below, not failed (the
        // non-native-preview gap is pre-existing #812, tracked in #927).
        let fixtures = ["test_0006.DNG", "test_0007.DNG", "test_0002.dng"]
        var ran = 0
        for name in fixtures {
            let rawURL = Self.fixtureDir("test-fixtures/raws").appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: rawURL.path) else { continue }

            // Auto cube must build (native preview present). If not, skip rather
            // than hard-fail — the cube being nil is the pre-existing
            // preview-extraction gap, not a residual-wiring defect.
            guard await AutoProfileLUT.shared.filter(
                forRawAt: rawURL, profile: .auto, quality: .full
            ) != nil else {
                print("[auto-parity] SKIP \(name): no native embedded preview (Apple renders Neutral)")
                continue
            }
            ran += 1

            // CPU references from the same dylib (= maple-cli render). Auto =
            // default model (AdjustmentModel::default() is Profile::Auto); Neutral
            // = a written Neutral sidecar. Both at default temperature=6500 → a
            // zero WB shift on the post-DCP D65 buffer = "As Shot", matching
            // renderApple's As-Shot WB so the only Auto-vs-Auto difference is the
            // tail, not white balance.
            let cpuAuto = try PipelineRenderer.render(rawPath: rawURL, xmpPath: nil, quality: .full)
            var neutralModel = AdjustmentModel.default
            neutralModel.profile = .neutral
            // omitWhiteBalance (#1883): this sidecar means "Neutral profile,
            // As-Shot WB". Writing the default model's literal 6500/0 became
            // an AUTHORED Custom WB (a camera-space D65 retarget) when #1726
            // introduced the temperature_seen/tint_seen resolution — absent
            // attributes are how a sidecar says As-Shot, matching the
            // `xmpPath: nil` Auto reference above.
            let neutralXML = XMPSerializer.serialize(
                model: neutralModel, culling: CullingState(), omitWhiteBalance: true)
            let neutralXMP = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("maple-neutral-\(UUID().uuidString).xmp")
            try neutralXML.write(to: neutralXMP, atomically: true, encoding: .utf8)
            defer { try? FileManager.default.removeItem(at: neutralXMP) }
            let cpuNeutral = try PipelineRenderer.render(rawPath: rawURL, xmpPath: neutralXMP, quality: .full)

            let appleAuto = try await renderApple(rawURL: rawURL, profile: .auto)
            let appleNeutral = try await renderApple(rawURL: rawURL, profile: .neutral)

            // Widen CPU (3 B/px, possibly a different demosaic resolution) to the
            // Apple canvas geometry.
            func matched(_ d: MapleImageData) -> (pixels: [UInt8], width: Int, height: Int) {
                let img = (pixels: Self.rgbToRGBA([UInt8](d.pixels)), width: d.width, height: d.height)
                return (img.width == appleAuto.width && img.height == appleAuto.height)
                    ? img : resampleNearest(img, toWidth: appleAuto.width, height: appleAuto.height)
            }
            let cpuAutoM = matched(cpuAuto)
            let cpuNeutralM = matched(cpuNeutral)

            // (a) DECISIVE FLOOR: Neutral-vs-Neutral, NO Auto tail. Isolates any
            // cross-engine decode/develop/encode divergence (WB, AgX, gamut) from
            // the Auto wiring. With As-Shot WB + FFI-shared AgX/encode this should
            // be small; a large value here is a pre-existing #812 decode issue,
            // not this PR — so it is asserted against its own (looser) neutral-
            // floor budget below, while (b) is the primary Auto-tail gate.
            let floor = perBandBias(cand: appleNeutral.pixels, ref: cpuNeutralM.pixels,
                                    width: appleNeutral.width, height: appleNeutral.height)
            for b in floor {
                print(String(format: "[neutral-floor %@] %.2f-%.2f R=%+.4f G=%+.4f B=%+.4f n=%d",
                             name as NSString, b.lo, b.hi, b.r, b.g, b.b, b.n))
                let nFloor = Self.neutralFloorBudget(fixture: name, bandLo: b.lo)
                XCTAssertLessThanOrEqual(abs(b.r), nFloor, "[\(name)] neutral-floor R band \(b.lo)-\(b.hi) — decode/WB regression?")
                XCTAssertLessThanOrEqual(abs(b.g), nFloor, "[\(name)] neutral-floor G band \(b.lo)-\(b.hi) — decode/WB regression?")
                XCTAssertLessThanOrEqual(abs(b.b), nFloor, "[\(name)] neutral-floor B band \(b.lo)-\(b.hi) — decode/WB regression?")
            }

            // (b) GATE: Auto-vs-Auto — the Apple composed cube vs the CPU full
            // Auto tail (#550 curve + residual via apply_auto_profile).
            let bias = perBandBias(cand: appleAuto.pixels, ref: cpuAutoM.pixels,
                                   width: appleAuto.width, height: appleAuto.height)
            for b in bias {
                print(String(format: "[auto-parity %@] %.2f-%.2f R=%+.4f G=%+.4f B=%+.4f n=%d",
                             name as NSString, b.lo, b.hi, b.r, b.g, b.b, b.n))
            }

            // The Auto tail must move the canvas vs Neutral (residual+curve live).
            let liveDelta = perBandBias(cand: appleAuto.pixels, ref: appleNeutral.pixels,
                                        width: appleAuto.width, height: appleAuto.height)
            let maxLive = liveDelta.map { max(abs($0.r), abs($0.g), abs($0.b)) }.max() ?? 0
            XCTAssertGreaterThan(maxLive, 0.01, "[\(name)] Auto must change the canvas vs Neutral")

            let budget = Self.autoVsCpuBandBiasBudget
            for b in bias {
                XCTAssertLessThanOrEqual(abs(b.r), budget, "[\(name)] R band \(b.lo)-\(b.hi)")
                XCTAssertLessThanOrEqual(abs(b.g), budget, "[\(name)] G band \(b.lo)-\(b.hi)")
                XCTAssertLessThanOrEqual(abs(b.b), budget, "[\(name)] B band \(b.lo)-\(b.hi)")
            }
        }
        if ran == 0 {
            throw XCTSkip("no Auto-parity fixtures present under test-fixtures/raws")
        }
    }
}
