// ImageEditPipeline+CaptureRefine.swift — the decode result a capture
// decode or a GPU capture refine (#5381) hands the decoded cache.

import CoreImage
import Foundation
import os

private let refineLog = Logger(subsystem: "app.justmaple.aperture", category: "capture-refine")

extension ImageEditPipeline {
  /// What a capture refine produced.
  public enum CaptureRefineOutcome: Sendable {
    case refined(SceneLinearDecodeResult)
    /// The edit needs a fresh develop (it changes more than the refinable
    /// stages, the base is over budget, or the GPU failed).
    case redevelop
    /// Superseded by a newer edit; nothing to publish.
    case cancelled
  }

  /// A scene-linear decode as the cache stores it. The CIImage copies the
  /// f32 RGBA bytes (#487), tagged extended linear Rec.2020.
  nonisolated static func sceneLinearResult(
    _ imageData: MapleSceneLinearImageData
  ) -> SceneLinearDecodeResult {
    let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
    let ciImage = mapleStage("decode CIImage build") {
      CIImage(
        bitmapData: imageData.pixels,
        bytesPerRow: imageData.width * imageData.bytesPerPixel,
        size: CGSize(width: imageData.width, height: imageData.height),
        format: .RGBAf,
        colorSpace: space
      )
    }
    return SceneLinearDecodeResult(
      image: ciImage,
      noiseProfile: imageData.noiseProfile,
      iso: imageData.iso,
      wbFrame: imageData.wbFrame,
      aeGain: imageData.aeGain,
      whitesAnchorEv: imageData.whitesAnchorEv, nrSamplingScale: imageData.nrSamplingScale,
      hasLensCorrections: imageData.hasLensCorrections,
      lensCorrectionCaInert: imageData.lensCorrectionCaInert,
      lensCorrectionDistortionInert: imageData.lensCorrectionDistortionInert,
      cameraSupport: imageData.cameraSupport, captureBase: imageData.captureBase
    )
  }

  /// Refine a cached decode's capture on the GPU to the model in `xmpPath`
  /// instead of re-developing the RAW: the refine for a chroma prefilter,
  /// deep denoise or capture-sharpening change. Retouch and every other
  /// decode-baked field still re-develop on the CPU.
  nonisolated public func refineCaptureDecode(
    base: CaptureBase,
    xmpPath: URL?,
    profileOverride: Profile? = nil,
    autoExposureOverride: AutoExposureMode? = nil,
    cancel: CancelFlag? = nil
  ) -> CaptureRefineOutcome {
    do {
      let refined = try mapleStage("GPU capture refine") {
        try PipelineRenderer.refineCapture(
          base: base, xmpPath: xmpPath, profileOverride: profileOverride,
          autoExposureOverride: autoExposureOverride, cancel: cancel)
      }
      return refined.map { .refined(Self.sceneLinearResult($0)) } ?? .redevelop
    } catch PipelineError.cancelled {
      return .cancelled
    } catch {
      refineLog.error(
        "capture refine failed, re-developing: \(error.localizedDescription, privacy: .public)")
      return .redevelop
    }
  }
}
