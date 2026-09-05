// LocalAdjustmentRenderTests.swift — the assertion whose absence let #3338
// ship: a mask must change rendered pixels.
//
// Everything else in this area tests a piece in isolation — the 32-float
// flat encoding (`LocalAdjustmentFlatTests`), the sidecar round trip
// (`XMPLocalAdjustmentsTests`), and raw-core's own CPU/WGSL parity for the
// layer math. All of them passed while the Apple shell never populated
// `MapleAdjustmentParams.local_adjustments_ptr`, so masks reached raw-core
// as an empty list and moved not one pixel. This drives the real FFI chain
// and compares the bytes.

import XCTest

@testable import MapleCore

final class LocalAdjustmentRenderTests: XCTestCase {
    /// A flat mid-grey scene-linear RGBA buffer, the shape the chain wants.
    private func sceneLinearGrey(width: Int, height: Int) -> Data {
        var floats = [Float]()
        floats.reserveCapacity(width * height * 4)
        for _ in 0..<(width * height) {
            floats.append(contentsOf: [0.25, 0.18, 0.12, 1.0])  // a warm, skin-ish tone
        }
        return floats.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    /// An everywhere-mask layer carrying one non-zero control.
    private func layer(_ adjustments: PartialAdjustments) -> LocalAdjustment {
        LocalAdjustment(mask: .everywhere, range: nil, adjustments: adjustments)
    }

    func testAnEverywhereMaskChangesRenderedPixels() throws {
        let (w, h) = (16, 16)
        let input = sceneLinearGrey(width: w, height: h)
        let params = PipelineRenderer.makeParams(from: AdjustmentModel())

        let unmasked = try PipelineRenderer.applySceneLinearChain(
            inputBytes: input, width: w, height: h, params: params)
        let masked = try PipelineRenderer.applySceneLinearChain(
            inputBytes: input, width: w, height: h, params: params,
            localAdjustments: [layer(PartialAdjustments(exposure: 2.0))])

        XCTAssertEqual(unmasked.count, masked.count)
        XCTAssertNotEqual(
            unmasked, masked,
            "an everywhere mask at +2 EV must change the rendered buffer — if these are "
                + "equal the layer stack never reached raw-core (#3338)")
    }

    /// The per-mask Hue control specifically (#3269) — the one the skin-tone
    /// workflow drags, and the one observed doing nothing on device.
    func testPerMaskHueChangesRenderedPixels() throws {
        let (w, h) = (16, 16)
        let input = sceneLinearGrey(width: w, height: h)
        let params = PipelineRenderer.makeParams(from: AdjustmentModel())

        let unmasked = try PipelineRenderer.applySceneLinearChain(
            inputBytes: input, width: w, height: h, params: params)
        let hued = try PipelineRenderer.applySceneLinearChain(
            inputBytes: input, width: w, height: h, params: params,
            localAdjustments: [layer(PartialAdjustments(hue: 77))])

        XCTAssertNotEqual(
            unmasked, hued,
            "per-mask Hue at 77 must rotate the rendered chroma (#3269/#3338)")
    }

    /// An empty stack must stay byte-identical to no stack at all, so the
    /// binding cannot perturb an unmasked render.
    func testNoLayersIsByteIdenticalToNoStack() throws {
        let (w, h) = (16, 16)
        let input = sceneLinearGrey(width: w, height: h)
        let params = PipelineRenderer.makeParams(from: AdjustmentModel())

        let baseline = try PipelineRenderer.applySceneLinearChain(
            inputBytes: input, width: w, height: h, params: params)
        let emptyStack = try PipelineRenderer.applySceneLinearChain(
            inputBytes: input, width: w, height: h, params: params, localAdjustments: [])

        XCTAssertEqual(baseline, emptyStack)
    }

    /// Magnitude check, not just inequality: a 23-degree Oklab hue rotation
    /// on a skin-like tone must move the pixel visibly, not by a rounding
    /// step. Prints the per-channel delta so a regression in the -100..100
    /// -> +-30deg scaling shows up as a number rather than a still-passing
    /// "not equal" assertion.
    func testHueAmplitudeIsVisible() throws {
        let (w, h) = (8, 8)
        let input = sceneLinearGrey(width: w, height: h)
        let params = PipelineRenderer.makeParams(from: AdjustmentModel())
        let base = try PipelineRenderer.applySceneLinearChain(
            inputBytes: input, width: w, height: h, params: params)
        let hued = try PipelineRenderer.applySceneLinearChain(
            inputBytes: input, width: w, height: h, params: params,
            localAdjustments: [layer(PartialAdjustments(hue: 77))])
        let b = base.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        let x = hued.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        let d = (0..<3).map { abs(b[$0] - x[$0]) }
        print("HUE77 base=\(b[0]),\(b[1]),\(b[2]) hued=\(x[0]),\(x[1]),\(x[2]) delta=\(d)")
        XCTAssertGreaterThan(d.max() ?? 0, 0.01, "hue 77 must move the tone visibly")
    }
}
