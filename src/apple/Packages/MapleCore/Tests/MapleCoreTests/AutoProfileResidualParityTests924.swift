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
    /// ≤ 0.0056.
    /// `autoVsCpu` — Apple composed cube vs CPU full Auto (#550 curve + residual
    /// via apply_auto_profile). Observed ≤ 0.0104 (darkest band, where the
    /// residual + trilinear gap is largest). A broken compose / wrong sample
    /// domain inflates it well past ceiling — the regression this gate catches.
    private static let neutralFloorBandBiasBudget = 0.012
    private static let autoVsCpuBandBiasBudget = 0.018

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
            let neutralXML = XMPSerializer.serialize(model: neutralModel, culling: CullingState())
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
            // not this PR (printed, not asserted — the tail gate is (b)).
            let floor = perBandBias(cand: appleNeutral.pixels, ref: cpuNeutralM.pixels,
                                    width: appleNeutral.width, height: appleNeutral.height)
            let nFloor = Self.neutralFloorBandBiasBudget
            for b in floor {
                print(String(format: "[neutral-floor %@] %.2f-%.2f R=%+.4f G=%+.4f B=%+.4f n=%d",
                             name as NSString, b.lo, b.hi, b.r, b.g, b.b, b.n))
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
