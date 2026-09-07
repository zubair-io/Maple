// MaskRemapRenderParityTests.swift — the remap through the REAL render
// chains (#355), not just the weight algebra.
//
// The CPU refine renders the whole frame with the stack as authored and
// crops afterwards; that is the reference every partial-frame path must
// reproduce. Two such paths exist on Apple, and each is driven here the way
// production drives it:
//
// - Native detail runs the CPU FFI chain (`maple_apply_scene_linear_chain
//   _f32`) on a 1:1 window of the frame. The window's remap is index-exact,
//   so the windowed render must equal the whole-frame render's window
//   pixel for pixel (f32 noise only).
// - GPU-live runs the wgpu chain (`GpuLiveSession.renderToBuffer`, the
//   headless twin of the present) on a buffer cropped BEFORE the chain.
//   The crop remap is continuous, so the cropped render is compared with
//   the whole-frame GPU render's crop AND with the CPU chain's, both under
//   a budget; the un-remapped stack is rendered too and must MISS that
//   budget, so the gate is known to see a misplaced mask.
//
// Flat scene-linear input throughout: the only spatial structure in the
// output is the mask itself, which is exactly what is under test.

import CoreImage
import XCTest

@testable import MapleCore

final class MaskRemapRenderParityTests: XCTestCase {
    private let radial = LocalMask.radial(
        center: MaskPoint(x: 0.55, y: 0.45), radii: MaskPoint(x: 0.3, y: 0.2),
        angle: 0.4, feather: 0.5, invert: false)
    private let linear = LocalMask.linear(
        start: MaskPoint(x: 0.2, y: 0.8), end: MaskPoint(x: 0.7, y: 0.2), feather: 0.6)
    private let controls = PartialAdjustments(exposure: 2.0, saturation: -40)

    private func flatFloats(width: Int, height: Int) -> [Float] {
        [Float](unsafeUninitializedCapacity: width * height * 4) { buf, n in
            for i in 0..<(width * height) {
                buf[i * 4] = 0.25; buf[i * 4 + 1] = 0.18; buf[i * 4 + 2] = 0.12; buf[i * 4 + 3] = 1
            }
            n = width * height * 4
        }
    }

    private func flatData(width: Int, height: Int) -> Data {
        flatFloats(width: width, height: height).withUnsafeBufferPointer { Data(buffer: $0) }
    }

    private func floats(_ data: Data) -> [Float] {
        data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }

    /// `window` (top-left pixel rect) of a `width`-wide `stride`-lane image.
    private func slice<T>(_ pixels: [T], width: Int, window: CGRect, lanes: Int) -> [T] {
        var out: [T] = []
        out.reserveCapacity(Int(window.width * window.height) * lanes)
        for y in Int(window.minY)..<Int(window.maxY) {
            let row = (y * width + Int(window.minX)) * lanes
            out.append(contentsOf: pixels[row..<(row + Int(window.width) * lanes)])
        }
        return out
    }

    private func maxAbsDiff(_ a: [Float], _ b: [Float]) -> Float {
        zip(a, b).reduce(0) { max($0, abs($1.0 - $1.1)) }
    }

    private func meanAbsDiff(_ a: [UInt8], _ b: [UInt8]) -> Double {
        precondition(a.count == b.count && !a.isEmpty)
        return Double(zip(a, b).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) }) / Double(a.count)
    }

    // MARK: - Native detail: the CPU chain on a window

    private func assertWindowedChainMatchesWholeFrame(_ mask: LocalMask, file: StaticString = #filePath, line: UInt = #line) throws {
        let (w, h) = (96, 64)
        let window = CGRect(x: 20, y: 10, width: 40, height: 30)
        // Sharpen and colour NR are spatial: on a window they see different
        // neighbours at the border than the whole frame does, which is what
        // production's `filterHalo` exists for. Off here so the only
        // spatial structure under comparison is the mask itself.
        var model = AdjustmentModel()
        model.sharpenAmount = 0
        model.nrColor = 0
        let params = PipelineRenderer.makeParams(from: model)
        let stack = [LocalAdjustment(mask: mask, adjustments: controls)]

        let whole = try PipelineRenderer.applySceneLinearChain(
            inputBytes: flatData(width: w, height: h), width: w, height: h, params: params, localAdjustments: stack)
        let reference = slice(floats(whole), width: w, window: window, lanes: 4)

        let affine = MaskAffine.windowToFullFrame(window: window, fullSize: CGSize(width: w, height: h))
        let remapped = try PipelineRenderer.applySceneLinearChain(
            inputBytes: flatData(width: Int(window.width), height: Int(window.height)),
            width: Int(window.width), height: Int(window.height), params: params,
            localAdjustments: MaskRemap.remappedGeometry(stack, through: affine))
        let unmapped = try PipelineRenderer.applySceneLinearChain(
            inputBytes: flatData(width: Int(window.width), height: Int(window.height)),
            width: Int(window.width), height: Int(window.height), params: params, localAdjustments: stack)

        let remappedDiff = maxAbsDiff(floats(remapped), reference)
        let unmappedDiff = maxAbsDiff(floats(unmapped), reference)
        print("WINDOW-PARITY \(mask) remapped=\(remappedDiff) unmapped=\(unmappedDiff)")
        XCTAssertLessThan(remappedDiff, 1e-4, "windowed chain must reproduce the whole-frame window", file: file, line: line)
        XCTAssertGreaterThan(unmappedDiff, 0.02, "the gate must see a mask normalised to the window instead", file: file, line: line)
    }

    func testRadialMaskOnANativeDetailWindowMatchesTheWholeFrameChain() throws {
        try assertWindowedChainMatchesWholeFrame(radial)
    }

    func testLinearMaskOnANativeDetailWindowMatchesTheWholeFrameChain() throws {
        try assertWindowedChainMatchesWholeFrame(linear)
    }

    // MARK: - GPU-live: the wgpu chain on a pre-cropped buffer

    /// Whole-frame GPU render cropped afterwards vs. a cropped buffer
    /// rendered with the remapped stack — production's CPU-refine-vs-live
    /// disagreement, reproduced headlessly on the same wgpu chain. The
    /// residual is the continuous-vs-index normalisation drift (under half
    /// a source pixel at the crop edges), well inside the budget; the
    /// un-remapped stack lands the mask in the wrong place and blows it.
    func testRadialMaskOnACroppedGpuLiveBufferMatchesTheWholeFrameRender() async throws {
        let full = CGSize(width: 512, height: 384)
        let crop = Crop(top: 0.2, left: 0.25, bottom: 0.85, right: 0.8, angle: 0)
        let yUp = try XCTUnwrap(CropImageStage.cropRect(crop, bufferSize: full, nativeSize: full))
        let window = CGRect(x: yUp.minX, y: full.height - yUp.maxY, width: yUp.width, height: yUp.height)
        let (cw, ch) = (Int(window.width), Int(window.height))

        var model = AdjustmentModel()
        model.profile = .neutral
        model.localAdjustments = [LocalAdjustment(mask: radial, adjustments: controls)]
        var remappedModel = model
        remappedModel.localAdjustments = MaskRemap.remappedGeometry(
            model.localAdjustments, through: MaskAffine.cropToFullFrame(crop, nativeSize: full))

        let wholeSession = try GpuLiveSession(
            pixels: flatFloats(width: Int(full.width), height: Int(full.height)),
            width: Int(full.width), height: Int(full.height))
        let wholeRender = try await wholeSession.renderToBuffer(model: model)
        let whole = try XCTUnwrap(wholeRender)
        let reference = slice(whole, width: Int(full.width), window: window, lanes: 3)

        let croppedSession = try GpuLiveSession(pixels: flatFloats(width: cw, height: ch), width: cw, height: ch)
        let remappedRender = try await croppedSession.renderToBuffer(model: remappedModel)
        let remapped = try XCTUnwrap(remappedRender)
        let unmappedRender = try await croppedSession.renderToBuffer(model: model)
        let unmapped = try XCTUnwrap(unmappedRender)

        let remappedDiff = meanAbsDiff(remapped, reference)
        let unmappedDiff = meanAbsDiff(unmapped, reference)
        let remappedMax = zip(remapped, reference).reduce(0) { max($0, abs(Int($1.0) - Int($1.1))) }
        print("GPU-CROP-PARITY remapped mean=\(remappedDiff)/255 max=\(remappedMax) unmapped mean=\(unmappedDiff)/255")
        XCTAssertLessThan(remappedDiff, 0.75, "cropped GPU-live render must match the whole-frame render's crop")
        XCTAssertLessThan(remappedMax, 6, "no pixel may stray past the edge-drift budget")
        XCTAssertGreaterThan(unmappedDiff, 4.0, "the gate must see the crop-normalised mask as misplaced")

        // And against the CPU chain the refine actually runs — the
        // canonical reference, display-encoded by the fused entry and
        // quantised the way `dither_and_quantize` does (nearest), so the
        // remaining gap is GPU-vs-CPU chain noise plus the same drift.
        let cpuWhole = try PipelineRenderer.applyChainAndEncodeDisplay(
            inputBytes: flatData(width: Int(full.width), height: Int(full.height)),
            width: Int(full.width), height: Int(full.height),
            params: PipelineRenderer.makeParams(from: model), localAdjustments: model.localAdjustments)
        let cpuRGB: [UInt8] = slice(floats(cpuWhole), width: Int(full.width), window: window, lanes: 4)
            .enumerated().filter { $0.offset % 4 != 3 }
            .map { UInt8(min(max($0.element, 0), 1) * 255 + 0.5) }
        let cpuDiff = meanAbsDiff(remapped, cpuRGB)
        print("GPU-CROP-PARITY vs CPU refine mean=\(cpuDiff)/255")
        XCTAssertLessThan(cpuDiff, 1.0, "cropped GPU-live render must match the CPU refine's crop")
    }
}
