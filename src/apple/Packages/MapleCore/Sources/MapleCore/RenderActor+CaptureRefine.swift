// RenderActor+CaptureRefine.swift — which cached decode a GPU capture
// refine (#5381) may replace.
//
// A sized RAW decode keeps its refine base beside the decoded image. A later
// decode request for the same photo, profile, exposure mode, quality and
// size refines from that base on the GPU; raw-ffi then checks the model
// itself and declines unless only chroma prefilter, deep denoise or capture
// sharpening changed, in which case the request re-develops as before. The
// refine runs under the decode's own cancel flag and publishes through the
// same write gate, so a superseded refine is dropped exactly like a
// superseded decode.

import CoreGraphics
import Foundation

#if os(iOS)
  import UIKit
#endif

/// The decode request a cached refine base answered.
struct CaptureRefineRequest: Equatable {
  let assetID: AssetRef.ID
  let sidecarURL: URL?
  let profile: Profile?
  let autoExposure: AutoExposureMode?
  let quality: PipelineRenderer.Quality
  /// The sized decode's long edge, as `decodeSceneLinearSized` derives it.
  let longEdge: Int

  init(
    asset: AssetRef, profile: Profile?, autoExposure: AutoExposureMode?,
    quality: PipelineRenderer.Quality, target: CGSize
  ) {
    self.assetID = asset.id
    self.sidecarURL = asset.sidecarURL
    self.profile = profile
    self.autoExposure = autoExposure
    self.quality = quality
    self.longEdge = max(1, Int(target.width.rounded()), Int(target.height.rounded()))
  }
}

extension RenderActor {
  /// The base a decode of `request` may refine from, if the cache holds one.
  func captureRefineBase(for request: CaptureRefineRequest) -> CaptureBase? {
    guard let cached = decodedCaptureBase, cached.request == request,
      decodedForAssetID == request.assetID
    else { return nil }
    return cached.base
  }
}

extension CaptureRefineBudget {
  /// Whether `model` engages a stage the GPU capture refine re-runs.
  static func engagesRefinableStage(_ model: AdjustmentModel) -> Bool {
    model.chromaPrefilter > 0 || model.deepDenoise > 0 || model.captureSharpeningAmount > 0
  }

  /// The iPhone capture edge (#5213 decision 7): while a refinable stage is
  /// engaged, a RAW decode develops at most `phoneLongEdge` on its long
  /// edge, so every refine of it fits the phone's budget. Other devices and
  /// edits keep `target`.
  @MainActor
  static func clampedDecodeTarget(model: AdjustmentModel, isRaw: Bool, target: CGSize?) -> CGSize? {
    guard isRaw, isPhone, engagesRefinableStage(model), let target else { return target }
    let longEdge = max(target.width, target.height)
    let cap = CGFloat(phoneLongEdge)
    guard longEdge > cap else { return target }
    return CGSize(width: target.width * cap / longEdge, height: target.height * cap / longEdge)
  }

  @MainActor
  private static var isPhone: Bool {
    #if os(iOS)
      UIDevice.current.userInterfaceIdiom == .phone
    #else
      false
    #endif
  }
}
