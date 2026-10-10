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
  /// True only when `renderedPreview` is a COMPLETED full-canvas render of
  /// the current model. False for cold-open seeds (cached JPEG, embedded
  /// JPEG, `.maple` sidecar preview) and for progressive composites that
  /// stitch a fresh viewport patch over an older underlay (visible-region
  /// refine, deep-zoom tiles). `persistCurrentPreviewToCache` gates on this:
  /// persisting a seed or a mixed-provenance composite bakes a tone seam
  /// into `RenderedPreviewCache` + the browse thumbnail that then reappears
  /// on every cold open until a full render overwrites it (#1881).
  ///
  /// Two stored halves (#4496): `previewIsCompletedRender` is what the
  /// render publish decided, and `previewOutlivedDecodeCache` records a
  /// `releaseTransientMemory` eviction. Reading this folds both in, so the
  /// persist gates stay shut after an eviction; writing it sets the
  /// completion and clears the eviction, so every existing writer keeps
  /// its meaning. The canvas readiness accessor below reads only the
  /// completion half: an eviction frees buffers, it does not take the
  /// frame off glass.
  var previewIsFullRender: Bool {
    get { previewIsCompletedRender && !previewOutlivedDecodeCache }
    set {
      previewIsCompletedRender = newValue
      previewOutlivedDecodeCache = false
    }
  }

  /// True while `renderedPreview` is a completed full-canvas render rather
  /// than a cold-open seed — the canvas-ready predicate reads this to let a
  /// CPU-published frame retire the seed thumbnail on the GPU leaf (#4496).
  /// Both inputs are observed, so a write to either one re-evaluates the
  /// canvas: a render publishes the image and raises the flag, and a seed
  /// publishes with the flag already false (`applyWorkflowVariant` clears
  /// it before the variant preview lands). Reads the completion half only:
  /// a `releaseTransientMemory` eviction closes the persist gates but
  /// leaves the frame on glass, so the seed must not come back over it.
  public var renderedPreviewIsFullRender: Bool {
    renderedPreview != nil && previewIsCompletedRender
  }

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
  /// strip decode OMITS WB (#1883) → As-Shot develop → the frame's own
  /// pair when present, else the legacy estimate. NOT 6500/0 (#1976):
  /// post-#1894 that mislabel overcooled every settled render to cyan.
  var wbDeltaAnchor: ImageEditPipeline.AsShotWB? {
    if let frame = wbSliderFrame, frame.isPresent {
      return ImageEditPipeline.AsShotWB(
        temperature: Double(frame.sceneCCT),
        tint: Double(frame.asShotTint)
      )
    }
    if cameraSupport?.resolution == .rawlerFallback {
      return ImageEditPipeline.AsShotWB(temperature: 6500.0, tint: 0.0)
    }
    guard let cct = asShotCCT, let t = asShotTint else { return nil }
    return ImageEditPipeline.AsShotWB(temperature: cct, tint: t)
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
