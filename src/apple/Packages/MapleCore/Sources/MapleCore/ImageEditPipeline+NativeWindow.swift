// ImageEditPipeline+NativeWindow.swift — #5169.
//
// `processSceneLinear` for the 100% native-detail patch. Same WB anchor,
// curves, mask stack, encode target and Auto Profile tail as the fused path,
// but the chain runs windowed: the patch's position in the full frame is
// passed down, so the S/H mask, masks, vignette and grain match the
// full-frame render. No perspective warp: native detail falls back to the
// whole-image refine for perspective, as it does for dehaze.

import CoreImage
import Foundation

extension ImageEditPipeline {
  nonisolated public func processSceneLinearWindow(
    decoded: CIImage,
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
    let frame = (wbFrame?.isPresent == true) ? wbFrame : nil
    let params = PipelineRenderer.makeParams(
      from: model,
      decodedTemperature: asShot?.temperature ?? 6500.0,
      decodedTint: asShot?.tint ?? 0.0,
      skipAgX: false,
      iso: iso,
      wbFrame: frame, whitesAnchorEv: whitesAnchorEv, nrSamplingScale: 1
    )
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
          curves: PipelineRenderer.ChainToneCurves(model: model),
          noiseProfile: noiseProfile,
          localAdjustments: model.localAdjustments,
          window: PipelineRenderer.chainWindow(origin: origin, fullSize: fullSize)
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
}
