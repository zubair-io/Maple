// GpuLiveDriver+CanvasHaze.swift — the buffer the native-detail patch
// measures its dehaze maps from while the GPU-live canvas is on glass
// (#5215). Tone curves, clarity and texture do not commute with the
// prescale `presentViaGpuLive` uploads at, so only that buffer measures the
// map the canvas recovers with.

import CoreImage

extension GpuLiveDriver {
  /// Recorded by `presentViaGpuLive` once `open` has uploaded the decode of
  /// `identity` prescaled to `targetSize`.
  func recordUploadedPrescale(_ targetSize: CGSize?, identity: GpuUploadIdentity) {
    uploadedPrescale = (targetSize, identity)
  }

  /// The buffer the GPU canvas renders: `base` — the decoded image of
  /// `decodeGeneration` — at the recorded prescale target. `nil` unless the
  /// open session holds that decode's uncropped upload at exactly the dims
  /// this prescale produces.
  func canvasHazeSource(base: CIImage, decodeGeneration: UInt64) -> NativeDetailHazeSource? {
    guard let uploadedPrescale, let dims = sessionDims,
      uploadedIdentity == uploadedPrescale.identity,
      uploadedPrescale.identity.decodeGeneration == decodeGeneration,
      uploadedPrescale.identity.crop == .identity
    else { return nil }
    let source = NativeDetailHazeSource(frame: base, targetSize: uploadedPrescale.targetSize)
    let extent = source.image.extent
    guard Int(extent.width.rounded()) == dims.width, Int(extent.height.rounded()) == dims.height
    else { return nil }
    return source
  }
}
