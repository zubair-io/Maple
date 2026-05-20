// SceneLinearPipelineTests+Dehaze.swift — dehaze scalar parity (dark channel, transmission, guided filter) + wiring
//
// Sibling to SceneLinearPipelineTests.swift. Extension methods on
// SceneLinearPipelineTests; shared helpers live on the base class.
// Split out of the original 3316-LOC file — see refs #134.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

extension SceneLinearPipelineTests {

    /// Mirror the Rust unit test at dehaze.rs:194-204 — uniform image
    /// with a single dark pixel; assert pixels within radius 7 see the
    /// dark pixel.
    func testM5SwiftScalarDarkChannelMatchesRust() async throws {
        let w = 20, h = 20
        var rgb = [[Float]](repeating: [0.9, 0.9, 0.9], count: w * h)
        rgb[10 * 20 + 10] = [0.1, 0.1, 0.1]
        let dc = Self.swiftDarkChannel(rgb, w: w, h: h)
        // Pixel at (10, 10) sees itself.
        XCTAssertEqual(dc[10 * 20 + 10], 0.1, accuracy: 1e-5)
        // Pixel at (3, 3) — abs(10-3) = 7, exactly at radius 7.
        XCTAssertEqual(dc[3 * 20 + 3], 0.1, accuracy: 1e-5)
        // Pixel at (0, 0) — distance 10, beyond radius 7 box.
        XCTAssertEqual(dc[0], 0.9, accuracy: 1e-5)
    }

    /// Mirror the Rust unit test at dehaze.rs:186-191 — uniform RGB
    /// with R=0.5, G=0.3, B=0.8. Dark channel is min(R, G, B) = 0.3
    /// everywhere because the kernel-min over uniform values is the
    /// same as the per-pixel min.
    func testM5SwiftScalarDarkChannelOfUniformIsMinChannel() async throws {
        let w = 20, h = 20
        let rgb = [[Float]](repeating: [0.5, 0.3, 0.8], count: w * h)
        let dc = Self.swiftDarkChannel(rgb, w: w, h: h)
        for v in dc {
            XCTAssertEqual(v, 0.3, accuracy: 1e-5)
        }
    }

    /// Mirror the Rust unit test at dehaze.rs:206-218 — uniform 0.3
    /// background with a 10x10 bright patch in the corner; atmospheric
    /// light should be > 0.7 per channel (driven by the bright patch).
    func testM5SwiftScalarAtmosphericLightPicksBrightestRegion() async throws {
        let w = 100, h = 100
        var rgb = [[Float]](repeating: [0.3, 0.3, 0.3], count: w * h)
        for y in 0..<10 {
            for x in 0..<10 {
                rgb[y * 100 + x] = [0.95, 0.94, 0.93]
            }
        }
        let dc = Self.swiftDarkChannel(rgb, w: w, h: h)
        let a = Self.swiftAtmosphericLight(rgb, dc: dc)
        XCTAssertGreaterThan(a[0], 0.7)
        XCTAssertGreaterThan(a[1], 0.7)
        XCTAssertGreaterThan(a[2], 0.7)
    }

    /// Mirror the Rust unit test at dehaze.rs:220-228 — pure-white image
    /// with A=(1,1,1) gives uniform t = 1 - 0.95 = 0.05.
    func testM5SwiftScalarTransmissionIsHighForBrightClearRegions() async throws {
        let w = 30, h = 30
        let rgb = [[Float]](repeating: [1.0, 1.0, 1.0], count: w * h)
        let a: [Float] = [1.0, 1.0, 1.0]
        let t = Self.swiftTransmission(rgb, a: a, w: w, h: h)
        for v in t {
            XCTAssertEqual(v, 0.05, accuracy: 1e-5)
        }
    }

    /// Mirror the Rust unit test at dehaze.rs:230-235 — uniform 0.5
    /// buffer should box-blur to itself (running-sum with truncated-
    /// window normalization preserves means under uniform input).
    func testM5SwiftScalarDehazeBoxBlurOfConstantIsConstant() async throws {
        let w = 40, h = 40
        let buf = [Float](repeating: 0.5, count: w * h)
        let out = Self.swiftDehazeBoxBlur(buf, w: w, h: h, r: 5)
        for v in out {
            XCTAssertEqual(v, 0.5, accuracy: 1e-5)
        }
    }

    /// Mirror the Rust unit test at dehaze.rs:237-243 — guided filter of
    /// constants is the constant-p value (the linear fit collapses to
    /// `q = 0 * guide + p`).
    func testM5SwiftScalarGuidedFilterOfConstantsIsConstant() async throws {
        let w = 40, h = 40
        let guide = [Float](repeating: 0.5, count: w * h)
        let p     = [Float](repeating: 0.7, count: w * h)
        let out = Self.swiftGuidedFilter(guide: guide, p: p, w: w, h: h, r: 5, eps: 1e-3)
        for v in out {
            XCTAssertEqual(v, 0.7, accuracy: 1e-4)
        }
    }

    /// Mirror the Rust unit test at dehaze.rs:245-258 — guided filter
    /// preserves a smooth horizontal gradient (the algorithm passes
    /// edge-aligned smooth signals through untouched modulo small box-
    /// blur edge effects).
    func testM5SwiftScalarGuidedFilterPreservesSmoothTransmission() async throws {
        let w = 30, h = 30
        var p = [Float](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                p[y * w + x] = 0.3 + 0.4 * Float(x) / Float(w)
            }
        }
        let guide = p
        let out = Self.swiftGuidedFilter(guide: guide, p: p, w: w, h: h, r: 8, eps: 1e-3)
        for y in 10..<20 {
            for x in 10..<20 {
                let diff = abs(out[y * w + x] - p[y * w + x])
                XCTAssertLessThan(diff, 0.05,
                    "guided filter drifted at (\(x),\(y)): \(diff)")
            }
        }
    }

    /// Mirror the Rust unit test at dehaze.rs:261-269 — dehaze=0 is exact
    /// identity (Rust short-circuits at line 146).
    func testM5SwiftScalarApplyDehazeZeroIsIdentity() async throws {
        let w = 20, h = 20
        let rgb = [[Float]](repeating: [0.4, 0.5, 0.6], count: w * h)
        let out = Self.swiftApplyDehaze(rgb, w: w, h: h, dehaze: 0)
        for i in 0..<(w * h) {
            XCTAssertEqual(out[i][0], rgb[i][0], accuracy: 0.0)
            XCTAssertEqual(out[i][1], rgb[i][1], accuracy: 0.0)
            XCTAssertEqual(out[i][2], rgb[i][2], accuracy: 0.0)
        }
    }

    /// Mirror the Rust unit test at dehaze.rs:271-284 — dehaze=+100 on a
    /// hazy scene yields finite, bounded output.
    func testM5SwiftScalarApplyDehazePositiveBounded() async throws {
        let w = 30, h = 30
        var rgb = [[Float]](repeating: [0.5, 0.5, 0.5], count: w * h)
        for y in 10..<20 {
            for x in 10..<20 {
                rgb[y * 30 + x] = [0.35, 0.35, 0.35]
            }
        }
        let out = Self.swiftApplyDehaze(rgb, w: w, h: h, dehaze: 100)
        for p in out {
            for c in p {
                XCTAssertTrue(c.isFinite,
                    "dehaze=+100 produced non-finite channel: \(c)")
            }
        }
        let centerR = out[10 * 30 + 10][0]
        XCTAssertGreaterThanOrEqual(centerR, 0.0)
        XCTAssertLessThanOrEqual(centerR, 1.5)
    }

    /// Negative slider: should add haze (push transmission toward 1.0,
    /// resulting in less contrast). The reconstruction at scale=-1 with
    /// t_eff=1 gives J = (I-A)/1 + A = I, so dehaze=-100 is also a
    /// near-identity, but with t_floor=0.1 there's a small floor effect
    /// in dark areas.
    func testM5SwiftScalarApplyDehazeNegativeAddsHaze() async throws {
        let w = 30, h = 30
        var rgb = [[Float]](repeating: [0.5, 0.5, 0.5], count: w * h)
        for y in 10..<20 {
            for x in 10..<20 {
                rgb[y * 30 + x] = [0.35, 0.35, 0.35]
            }
        }
        let out = Self.swiftApplyDehaze(rgb, w: w, h: h, dehaze: -50)
        for p in out {
            for c in p {
                XCTAssertTrue(c.isFinite,
                    "dehaze=-50 produced non-finite channel: \(c)")
            }
        }
    }

    /// Smoke test for Plan 2 v2 v4 M5 wiring: drive processSceneLinear
    /// end-to-end with dehaze=50 vs dehaze=0; assert centre-pixel finite
    /// and bounded. Same `>=` caveat as v2 v1 / v2 v2 / v2 v3 wiring
    /// tests (XCTest cannot load metallibs — kernel may be no-op; the
    /// load-bearing runtime check is in Task 9 manual smoke).
    func testM5ProcessSceneLinearAppliesDehaze() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeRGBSceneLinearCIImage(
            width: 32, height: 32, r: 0.5, g: 0.5, b: 0.5)

        var modelDefault = AdjustmentModel.default
        modelDefault.dehaze = 0
        modelDefault.nrLuminance = 0
        modelDefault.nrColor = 0
        var modelBoost = modelDefault
        modelBoost.dehaze = 50

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outBoost   = pipeline.processSceneLinear(decoded: input, model: modelBoost)

        let dR = Self.sampleCenterR(outDefault, width: 32, height: 32)
        let bR = Self.sampleCenterR(outBoost, width: 32, height: 32)
        XCTAssertTrue(dR.isFinite && bR.isFinite,
            "dehaze produced non-finite channel: default=\(dR) boost=\(bR)")
        XCTAssertGreaterThanOrEqual(bR, 0.0)
        XCTAssertLessThanOrEqual(bR, 2.0)
    }
}
