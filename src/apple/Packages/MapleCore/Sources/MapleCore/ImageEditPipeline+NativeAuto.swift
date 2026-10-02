import CoreImage
import Foundation

extension ImageEditPipeline {
  nonisolated public func processSceneLinear(
    decoded: CIImage,
    model: AdjustmentModel,
    targetSize: CGSize? = nil,
    asShot: AsShotWB? = nil,
    decodedAtModel: AdjustmentModel? = nil,
    profileLUT: CIFilter? = nil,
    assetID: UUID? = nil,
    noiseProfile: [Float]? = nil,
    iso: UInt32 = 0,
    wbFrame: WbSliderFrame? = nil,
    whitesAnchorEv: Float = .nan,
    targetPrimariesOverride: CanvasColorSpace? = nil
  ) -> CIImage {
    processSceneLinearResolved(
      decoded: decoded, model: model, targetSize: targetSize, asShot: asShot,
      decodedAtModel: decodedAtModel, profileLUT: profileLUT, assetID: assetID,
      noiseProfile: noiseProfile, iso: iso, wbFrame: wbFrame, whitesAnchorEv: whitesAnchorEv,
      targetPrimariesOverride: targetPrimariesOverride, nativeAutoProfile: nil) ?? decoded
  }

  nonisolated func processSceneLinearWithAuto(
    decoded: CIImage,
    model: AdjustmentModel,
    targetSize: CGSize? = nil,
    asShot: AsShotWB? = nil,
    decodedAtModel: AdjustmentModel? = nil,
    profileLUT: CIFilter? = nil,
    nativeAutoProfile: NativeAutoProfile?,
    assetID: UUID? = nil,
    noiseProfile: [Float]? = nil,
    iso: UInt32 = 0,
    wbFrame: WbSliderFrame? = nil,
    whitesAnchorEv: Float = .nan,
    targetPrimariesOverride: CanvasColorSpace? = nil
  ) throws -> CIImage {
    guard
      let result = processSceneLinearResolved(
        decoded: decoded, model: model, targetSize: targetSize, asShot: asShot,
        decodedAtModel: decodedAtModel, profileLUT: profileLUT, assetID: assetID,
        noiseProfile: noiseProfile, iso: iso, wbFrame: wbFrame, whitesAnchorEv: whitesAnchorEv,
        targetPrimariesOverride: nativeAutoProfile?.artifacts != nil
          ? .srgb : targetPrimariesOverride, nativeAutoProfile: nativeAutoProfile)
    else {
      throw PipelineError.renderFailed(code: 8, message: "Native Auto CPU render failed")
    }
    return result
  }
}
