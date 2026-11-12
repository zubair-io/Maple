// ImageEditPipeline+NativeWindow.swift — #5169.
//
// `processSceneLinear` for the 100% native-detail patch. Same WB anchor,
// curves, mask stack, encode target and Auto Profile tail as the fused path,
// but the chain runs windowed: the patch's position in the full frame is
// passed down, so the S/H mask, masks, vignette and grain match the
// full-frame render. Dehaze recovers with the haze maps of the canvas
// buffer the patch overlays (#3287, #5215): the GPU-live canvas's prescaled
// upload while that canvas is on glass, the whole decoded base otherwise.
// No perspective warp: native detail falls back to the whole-image refine
// for perspective.

import CoreImage
import Foundation
import RawPipeline

extension ImageEditPipeline {
  nonisolated func processSceneLinearWindow(
    decoded: CIImage,
    hazeSource: NativeDetailHazeSource?,
    model: AdjustmentModel,
    origin: CGPoint,
    fullSize: CGSize,
    asShot: AsShotWB?,
    noiseProfile: [Float]?,
    iso: UInt32,
    wbFrame: WbSliderFrame?,
    whitesAnchorEv: Float,
    encodePlan: DisplayEncodePlan
  ) throws -> CIImage {
    let extent = decoded.extent
    let w = Int(extent.width.rounded())
    let h = Int(extent.height.rounded())
    guard w > 0, h > 0 else {
      throw PipelineError.renderFailed(code: 2, message: "native detail: empty patch")
    }
    let params = PipelineRenderer.makeParams(
      from: model,
      decodedTemperature: asShot?.temperature ?? 6500.0,
      decodedTint: asShot?.tint ?? 0.0,
      skipAgX: false,
      iso: iso,
      wbFrame: wbFrame, whitesAnchorEv: whitesAnchorEv, nrSamplingScale: 1
    )
    let curves = PipelineRenderer.ChainToneCurves(model: model)
    let haze = try hazeMap(
      source: hazeSource, model: model, params: params, curves: curves, noiseProfile: noiseProfile)
    let rowBytes = w * 16
    let encoded: Data = try autoreleasepool {
      var input = Data(count: rowBytes * h)
      input.withUnsafeMutableBytes { buf in
        context.render(
          decoded,
          toBitmap: buf.baseAddress!,
          rowBytes: rowBytes,
          bounds: CGRect(x: extent.minX, y: extent.minY, width: CGFloat(w), height: CGFloat(h)),
          format: .RGBAf,
          colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        )
      }
      let window = PipelineRenderer.chainWindow(origin: origin, fullSize: fullSize)
      return try mapleStage("native detail windowed chain+encode") {
        if let lattice = encodePlan.p3Auto {
          return try PipelineRenderer.applyChainAndEncodeDisplayP3Auto(
            inputBytes: input, width: w, height: h, params: params, curves: curves,
            noiseProfile: noiseProfile, localAdjustments: model.localAdjustments,
            lattice: lattice, window: window, haze: haze)
        }
        return try PipelineRenderer.applyChainAndEncodeDisplayTargetWindow(
          inputBytes: input, width: w, height: h, params: params,
          targetPrimaries: encodePlan.target.wireValue,
          curves: curves,
          noiseProfile: noiseProfile,
          localAdjustments: model.localAdjustments,
          window: window,
          haze: haze
        )
      }
    }
    let image = CIImage(
      bitmapData: encoded,
      bytesPerRow: rowBytes,
      size: CGSize(width: w, height: h),
      format: .RGBAf,
      colorSpace: encodePlan.colorSpace
    )
    return AutoProfileLUT.apply(encodePlan.cube, to: image)
  }

  /// The dehaze maps for the patch (#3287, #5215), measured from `source`:
  /// the GPU-live canvas's prescaled upload while that canvas is on glass
  /// (tone curves, clarity and texture do not commute with the prescale, so
  /// only that buffer measures the map the canvas recovers with), the
  /// decoded base otherwise. Kept in `NativeDetailHazeCache` per (frame,
  /// prescale target, `sceneLinearHazeKey`), so a pan or a dehaze move
  /// neither renders the frame nor hands it to Rust again. `nil` when no
  /// dehaze is engaged; throws when it is but no frame is available.
  nonisolated func hazeMap(
    source: NativeDetailHazeSource?,
    model: AdjustmentModel,
    params: MapleAdjustmentParams,
    curves: PipelineRenderer.ChainToneCurves,
    noiseProfile: [Float]?
  ) throws -> PipelineRenderer.HazeMap? {
    let key = PipelineRenderer.sceneLinearHazeKey(
      params: params, curves: curves, noiseProfile: noiseProfile,
      localAdjustments: model.localAdjustments)
    guard key != 0 else { return nil }
    guard let source else {
      throw PipelineError.renderFailed(
        code: 8, message: "native detail: dehaze needs the decoded frame for its haze map")
    }
    return try NativeDetailHazeCache.shared.map(source: source, key: key) {
      try measureHazeMap(
        frame: source.image, model: model, params: params, curves: curves,
        noiseProfile: noiseProfile)
    }
  }

  nonisolated private func measureHazeMap(
    frame: CIImage,
    model: AdjustmentModel,
    params: MapleAdjustmentParams,
    curves: PipelineRenderer.ChainToneCurves,
    noiseProfile: [Float]?
  ) throws -> PipelineRenderer.HazeMap? {
    let extent = frame.extent
    let w = Int(extent.width.rounded())
    let h = Int(extent.height.rounded())
    guard w > 0, h > 0 else { return nil }
    let rowBytes = w * 16
    return try autoreleasepool {
      var bytes = Data(count: rowBytes * h)
      bytes.withUnsafeMutableBytes { buf in
        context.render(
          frame,
          toBitmap: buf.baseAddress!,
          rowBytes: rowBytes,
          bounds: CGRect(x: extent.minX, y: extent.minY, width: CGFloat(w), height: CGFloat(h)),
          format: .RGBAf,
          colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        )
      }
      return try mapleStage("native detail haze map") {
        try PipelineRenderer.sceneLinearHazeMap(
          frameBytes: bytes, width: w, height: h, params: params, curves: curves,
          noiseProfile: noiseProfile, localAdjustments: model.localAdjustments)
      }
    }
  }
}
