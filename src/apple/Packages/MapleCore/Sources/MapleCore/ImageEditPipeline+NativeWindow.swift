// ImageEditPipeline+NativeWindow.swift — #5169.
//
// `processSceneLinear` for the 100% native-detail patch. Same WB anchor,
// curves, mask stack, encode target and Auto Profile tail as the fused path,
// but the chain runs windowed: the patch's position in the full frame is
// passed down, so the S/H mask, masks, vignette and grain match the
// full-frame render. Dehaze recovers with the haze maps of `fullFrame`, the
// whole decoded base (#3287). No perspective warp: native detail falls back
// to the whole-image refine for perspective.

import CoreImage
import Foundation
import RawPipeline

extension ImageEditPipeline {
  nonisolated public func processSceneLinearWindow(
    decoded: CIImage,
    fullFrame: CIImage?,
    model: AdjustmentModel,
    origin: CGPoint,
    fullSize: CGSize,
    asShot: AsShotWB?,
    profileLUT: CIFilter?,
    noiseProfile: [Float]?,
    iso: UInt32,
    wbFrame: WbSliderFrame?,
    whitesAnchorEv: Float,
    targetPrimaries: CanvasColorSpace
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
      frame: fullFrame, model: model, params: params, curves: curves, noiseProfile: noiseProfile)
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
      return try mapleStage("native detail windowed chain+encode") {
        try PipelineRenderer.applyChainAndEncodeDisplayTargetWindow(
          inputBytes: input, width: w, height: h, params: params,
          targetPrimaries: targetPrimaries.wireValue,
          curves: curves,
          noiseProfile: noiseProfile,
          localAdjustments: model.localAdjustments,
          window: PipelineRenderer.chainWindow(origin: origin, fullSize: fullSize),
          haze: haze
        )
      }
    }
    let tag =
      targetPrimaries == .displayP3
      ? Self.displayEncodedColorSpaceP3 : Self.displayEncodedColorSpace
    let image = CIImage(
      bitmapData: encoded,
      bytesPerRow: rowBytes,
      size: CGSize(width: w, height: h),
      format: .RGBAf,
      colorSpace: tag
    )
    return AutoProfileLUT.apply(profileLUT, to: image)
  }

  /// The whole frame's dehaze maps for the patch (#3287): `frame`, the decoded
  /// base the CPU whole-image chain renders, at its own resolution — tone
  /// curves, clarity and texture do not commute with a downscale. The GPU
  /// canvas prescales its copy, so its map can part slightly (#5215). Kept in
  /// `NativeDetailHazeCache` per (frame, `sceneLinearHazeKey`), so a pan or a
  /// dehaze move renders no frame copy. `nil` when no dehaze is engaged;
  /// throws when it is but the decoded frame is not available.
  nonisolated func hazeMap(
    frame: CIImage?,
    model: AdjustmentModel,
    params: MapleAdjustmentParams,
    curves: PipelineRenderer.ChainToneCurves,
    noiseProfile: [Float]?
  ) throws -> PipelineRenderer.HazeMap? {
    let key = PipelineRenderer.sceneLinearHazeKey(
      params: params, curves: curves, noiseProfile: noiseProfile,
      localAdjustments: model.localAdjustments)
    guard key != 0 else { return nil }
    guard let frame else {
      throw PipelineError.renderFailed(
        code: 8, message: "native detail: dehaze needs the decoded frame for its haze map")
    }
    return try NativeDetailHazeCache.shared.map(frame: frame, key: key) {
      try measureHazeMap(
        frame: frame, model: model, params: params, curves: curves, noiseProfile: noiseProfile)
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
