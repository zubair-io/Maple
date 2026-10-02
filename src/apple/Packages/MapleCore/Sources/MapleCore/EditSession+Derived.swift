// EditSession+Derived.swift — pure derived state read across the render and
// canvas paths: the crop the renderer should actually apply, the extent the
// canvas/zoom math anchors to, and the white-balance delta anchor.
//
// Split out of `EditSession.swift` under the 570-line headroom ratchet
// (#2311): these are computed properties with no storage, so they move
// cleanly to an extension while the stored fields they read stay on the
// class.

import CoreGraphics
import Foundation

@MainActor
extension EditSession {
  /// The crop rect the render path should apply right now: identity while
  /// the crop tool is armed (show the full frame under the overlay),
  /// otherwise the model's crop. Mirrors the web `renderModelForCrop`.
  var effectiveCrop: Crop {
    cropEditingActive ? .identity : model.crop
  }

  /// Image extent the canvas / zoom math should anchor to: the CROPPED
  /// size when a crop is applied (not editing), otherwise the full-frame
  /// `nativeImageSize`. Keeps fit / 100% / pan and the canvas frame on the
  /// cropped image. `.zero` until the metadata seed lands (same contract
  /// as `nativeImageSize`).
  public var effectiveImageSize: CGSize {
    guard nativeImageSize != .zero else { return nativeImageSize }
    return CropImageStage.croppedSize(effectiveCrop, nativeSize: nativeImageSize)
  }

  /// The WB delta anchor: the WB actually baked into the buffer. The
  /// calibrated strip decode bakes As-Shot WB (#1883/#1976). Frame-less
  /// RAWs use the shared core's absolute CAT16 fallback instead (#1472),
  /// so their metadata estimate must not become a second WB transform.
  var wbDeltaAnchor: ImageEditPipeline.AsShotWB? {
    if let frame = wbSliderFrame, frame.isPresent {
      return ImageEditPipeline.AsShotWB(
        temperature: Double(frame.sceneCCT),
        tint: Double(frame.asShotTint)
      )
    }
    return nil
  }

  // Forwarders onto `deepZoomState` — see that property's doc in
  // `EditSession.swift` for why these stay public.
  public internal(set) var viewportSourceRect: CGRect {
    get { deepZoomState.viewportSourceRect }
    set { deepZoomState.viewportSourceRect = newValue }
  }

  public var previewSize: CGSize {
    get { deepZoomState.previewSize }
    set {
      let oldValue = deepZoomState.previewSize
      guard newValue != oldValue else { return }
      deepZoomState.previewSize = newValue
      clearNativeDetailPreview()
      if oldValue == .zero {
        _scheduleRender(phase: .fast)
      } else {
        _scheduleRefine()
      }
      retryCachedPreviewSeedIfPending()
    }
  }
}
