// EditSession+Crop.swift
// MapleCore
//
// The crop-aware derived geometry (`effectiveCrop`, `effectiveImageSize`),
// moved out of `EditSession.swift` for the file-size budget (#3275). Pure
// relocation — the stored crop state (`cropEditingActive`) stays in the
// class body.

import CoreGraphics

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
}
