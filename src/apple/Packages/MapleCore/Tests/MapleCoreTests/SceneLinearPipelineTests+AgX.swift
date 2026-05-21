// SceneLinearPipelineTests+AgX.swift — AgX per-channel view transform (LUT + smoothstep) parity
//
// Sibling to SceneLinearPipelineTests.swift. Extension methods on
// SceneLinearPipelineTests; shared helpers live on the base class.
// Split out of the original 3316-LOC file — see refs #134.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

extension SceneLinearPipelineTests {

    /// AgX is per-channel (Metal kernel and Rust scalar agree on this — see
    /// AgXViewTransform.metal:53-65 and view/agx.rs:67-77). For neutral and
    /// in-gamut pixels, feeding the same triple through Rust's
    /// `agx_per_channel` produces the same output regardless of whether we
    /// *call* the values "Rec.2020" or "sRGB" — the math doesn't read the
    /// primaries at all. The only place the primary choice matters is on
    /// out-of-gamut content where the scene-linear value in one space is
    /// negative or extreme-positive in another (Rec.2020's wider gamut is a
    /// superset of sRGB's, so an in-gamut Rec.2020 pixel is at most ~1.4 in
    /// any sRGB channel; AgX's log+sigmoid handles that range fine).
    func testSpikeAgXIsPrimaryAgnosticPerChannel() {
        // Test pixels covering scene-linear behaviour:
        //   1) Mid-gray (0.18, 0.18, 0.18) — anchor point.
        //   2) Bright neutral (5.0, 5.0, 5.0) — well above mid-gray.
        //   3) Highly saturated red 20× mid-gray with green/blue at mid-gray.
        //   4) Below-toe (0.001, 0.001, 0.001).
        let testPixels: [(String, Float, Float, Float)] = [
            ("mid-gray", 0.18, 0.18, 0.18),
            ("bright-neutral", 5.0, 5.0, 5.0),
            ("saturated-red", 3.6, 0.18, 0.18),
            ("below-toe", 0.001, 0.001, 0.001),
        ]
        for (label, r, g, b) in testPixels {
            // Same input fed twice — the kernel can't tell which space.
            let outR = Self.agxPerChannelSmoothstep(r, slope: 1.0)
            let outG = Self.agxPerChannelSmoothstep(g, slope: 1.0)
            let outB = Self.agxPerChannelSmoothstep(b, slope: 1.0)
            XCTAssertTrue(outR.isFinite && outG.isFinite && outB.isFinite,
                "\(label): non-finite AgX output")
            XCTAssertTrue(outR >= 0.0 && outR <= 1.0 + 1e-4,
                "\(label) R out of [0,1]: \(outR)")
            XCTAssertTrue(outG >= 0.0 && outG <= 1.0 + 1e-4,
                "\(label) G out of [0,1]: \(outG)")
            XCTAssertTrue(outB >= 0.0 && outB <= 1.0 + 1e-4,
                "\(label) B out of [0,1]: \(outB)")
        }
        // Mid-gray must hit a stable, well-defined value. Note: the plan
        // brief asserts ~0.45 here, but the smoothstep stand-in evaluated
        // at MID_NORM ≈ 0.6061 produces 0.6061² · (3 − 2·0.6061) ≈ 0.657,
        // not 0.45. The real Rust LUT lands at AGX_MID_DISPLAY = 0.497
        // (see agx_coeffs.rs:20). Both are validated separately by
        // `testSpikeAgXMatchesRustReferenceWithLUT` below — that's the
        // test that actually compares against the production LUT.
        // This assertion just locks down the smoothstep stand-in's own
        // determinism so a regression in the analytic curve trips a
        // failure here even if the LUT-load test is skipped.
        let midOut = Self.agxPerChannelSmoothstep(0.18, slope: 1.0)
        XCTAssertEqual(midOut, 0.657, accuracy: 0.01,
            "smoothstep stand-in at mid-gray should land at ~0.657 (smoothstep(MID_NORM)), got \(midOut)")
    }

    /// Stricter mirror that loads the same `agx_lut.bin` Rust uses (via
    /// `Bundle.module`) and applies linear interpolation identical to
    /// `view/agx.rs:52-77`. Compared against Rust's per-channel AgX kernel
    /// outputs captured at AGX_VERSION 6 by `examples/spike_1_2_refs.rs`.
    /// The fixture bypasses `view::agx::apply`'s pre-form rolloff wrapper
    /// (added in AGX_VERSION 6) and calls the per-channel kernel directly
    /// so the Swift LUT mirror can match. The LUT binary is byte-identical
    /// across Rust and Swift, so the only deltas should be f32 rounding
    /// (~1e-7) — well below the LUT-interpolation noise floor (~1e-4)
    /// the Spike 1.2 brief calls for.
    ///
    /// This is the Spike 1.2 deliverable in the form the brief asks for:
    /// run the Swift mirror on the brief's fixed grid, run Rust on the
    /// same grid, report mean / P95 / max abs delta in normalized [0,1].
    func testSpikeAgXMatchesRustReferenceWithLUT() throws {
        let lut = try loadAgxLUT()
        let refs = SceneLinearPipelineTests.rustReferenceOutputs

        var deltas: [Float] = []
        var maxLabel = ""
        var maxDelta: Float = 0
        for (label, scene, displayRef) in refs {
            let outR = agxPerChannelLUT(scene.x, lut: lut, slope: 1.0)
            let outG = agxPerChannelLUT(scene.y, lut: lut, slope: 1.0)
            let outB = agxPerChannelLUT(scene.z, lut: lut, slope: 1.0)
            for (got, ref) in zip([outR, outG, outB],
                                  [displayRef.x, displayRef.y, displayRef.z]) {
                let d = abs(got - ref)
                deltas.append(d)
                if d > maxDelta {
                    maxDelta = d
                    maxLabel = label
                }
            }
        }
        let mean = deltas.reduce(0, +) / Float(deltas.count)
        let sorted = deltas.sorted()
        let p95 = sorted[Int(Float(sorted.count - 1) * 0.95)]

        print(String(format:
            "[Spike 1.2] LUT mirror vs Rust ref (n=%d): mean=%.3e p95=%.3e max=%.3e (max-label=%@)",
            deltas.count, mean, p95, maxDelta, maxLabel))

        // Brief threshold: max abs delta within LUT-interpolation noise floor
        // (~1e-4). LUT is shared (same binary), interpolation is identical,
        // so deltas are f32 rounding only.
        XCTAssertLessThan(maxDelta, 1e-4,
            "Spike 1.2 FAIL: Swift LUT mirror diverges from Rust reference. "
            + "max=\(maxDelta) (\(maxLabel)), p95=\(p95), mean=\(mean). "
            + "Expected max < 1e-4 — per-channel math is NOT primary-agnostic, "
            + "or the Swift mirror is not faithfully porting the Rust LUT path.")
    }

    /// The math doesn't read primaries — confirm it explicitly. Two
    /// invocations of the per-channel kernel with identical scalar inputs
    /// must produce bit-identical outputs regardless of whether the caller
    /// labels the input "Rec.2020" or "sRGB".
    func testSpikeAgXOutputBitIdenticalRegardlessOfPrimaryLabel() throws {
        let lut = try loadAgxLUT()
        let scenes: [SIMD3<Float>] = [
            SIMD3(0.18, 0.18, 0.18),
            SIMD3(0.5, 0.3, 0.2),
            SIMD3(2.0, 1.0, 0.05),
            SIMD3(0.001, 0.0, 5.0),
        ]
        for s in scenes {
            // "Rec.2020" interpretation
            let r1 = agxPerChannelLUT(s.x, lut: lut, slope: 1.0)
            let g1 = agxPerChannelLUT(s.y, lut: lut, slope: 1.0)
            let b1 = agxPerChannelLUT(s.z, lut: lut, slope: 1.0)
            // "sRGB" interpretation — same scalars, the kernel cannot tell.
            let r2 = agxPerChannelLUT(s.x, lut: lut, slope: 1.0)
            let g2 = agxPerChannelLUT(s.y, lut: lut, slope: 1.0)
            let b2 = agxPerChannelLUT(s.z, lut: lut, slope: 1.0)
            XCTAssertEqual(r1, r2, "primary label leaked into AgX R for \(s)")
            XCTAssertEqual(g1, g2, "primary label leaked into AgX G for \(s)")
            XCTAssertEqual(b1, b2, "primary label leaked into AgX B for \(s)")
        }
    }

    /// Hard parity gate: the LUT binary embedded in MapleCore (used by the
    /// production Metal kernel) MUST match the LUT binary embedded in
    /// raw-core (used by the production Rust path). If these diverge,
    /// Apple and the Rust reference render differ across the entire tone
    /// range — even a perfectly-implemented Metal kernel cannot match Rust
    /// output. Spike 1.2 originally flagged this as a known divergence
    /// (Apple bundled at AGX_VERSION 2 vs Rust at 5, max |Δ|=0.2796 at
    /// LUT index 301) and logged without failing. The Spike 1.2 follow-up
    /// regenerated both LUTs from `derive_agx_lut.py --apple-bin …`,
    /// promoted this assertion to a hard equality check, and moved the
    /// codegen path so `--apple-bin` is the supported way to keep them
    /// aligned.
    ///
    /// PASS: the two binaries are byte-identical.
    /// FAIL: they diverge — re-run `derive_agx_lut.py` with `--apple-bin`
    ///   pointed at `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/agx_lut.bin`
    ///   and commit the result.
    func testAppleBundledAgxLUTMatchesRustLUT() throws {
        guard let appleData = MetalKernels.agxLUTBytes() else {
            XCTFail("MapleCore Metal/agx_lut.bin not bundled — SwiftPM resource path broken")
            return
        }
        let here = URL(fileURLWithPath: #filePath)
        var root = here
        for _ in 0..<7 { root.deleteLastPathComponent() }
        let rustURL = root
            .appendingPathComponent("src/raw-pipeline/raw-core/src/view/agx_lut.bin")
        guard FileManager.default.fileExists(atPath: rustURL.path) else {
            throw XCTSkip("Rust agx_lut.bin not found at \(rustURL.path)")
        }
        let rustData = try Data(contentsOf: rustURL)
        // Sizes first — a length mismatch makes a byte diff meaningless.
        XCTAssertEqual(appleData.count, 2048, "Apple LUT size must be 512 × f32 = 2048 bytes")
        XCTAssertEqual(rustData.count,  2048, "Rust LUT size must be 512 × f32 = 2048 bytes")
        // Hard equality gate. If this ever fails again, decode + report
        // the worst index so the failure message is diagnostic.
        if appleData != rustData {
            let nApple = appleData.count / 4
            let nRust = rustData.count / 4
            var aLUT = [Float32](repeating: 0, count: nApple)
            var rLUT = [Float32](repeating: 0, count: nRust)
            appleData.withUnsafeBytes { src in
                aLUT.withUnsafeMutableBytes { dst in
                    dst.baseAddress?.copyMemory(from: src.baseAddress!, byteCount: appleData.count)
                }
            }
            rustData.withUnsafeBytes { src in
                rLUT.withUnsafeMutableBytes { dst in
                    dst.baseAddress?.copyMemory(from: src.baseAddress!, byteCount: rustData.count)
                }
            }
            var maxDiff: Float = 0
            var maxIdx: Int = 0
            for i in 0..<min(nApple, nRust) {
                let d = abs(aLUT[i] - rLUT[i])
                if d > maxDiff { maxDiff = d; maxIdx = i }
            }
            XCTFail(String(format:
                "Apple-bundled agx_lut.bin diverges from Rust agx_lut.bin: max |Δ|=%.4f at LUT index %d (Apple=%.4f, Rust=%.4f). Re-bake via `python3 src/scripts/derive_agx_lut.py --bin src/raw-pipeline/raw-core/src/view/agx_lut.bin --rs src/raw-pipeline/raw-core/src/view/agx_coeffs.rs --apple-bin src/apple/Packages/MapleCore/Sources/MapleCore/Metal/agx_lut.bin` and commit.",
                maxDiff, maxIdx, aLUT[maxIdx], rLUT[maxIdx]))
        }
    }
}
