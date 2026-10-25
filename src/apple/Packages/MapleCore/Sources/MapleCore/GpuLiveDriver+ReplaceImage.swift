// GpuLiveDriver+ReplaceImage.swift — atomic publish of a same-size re-decode
// (#5381). A GPU capture refine re-develops the decoded cache at the same
// size and crop, so instead of closing the session and opening another the
// driver writes the new pixels into the open one
// (`LiveSession::update_image`), keeping its buffers, pool and Auto Profile
// fit.

import Foundation

/// The decode exports a session is opened with, compared on replacement.
struct GpuUploadExports {
  let noiseProfile: [Float]?
  let iso: UInt32
  let whitesAnchorEv: Float
  let nrSamplingScale: Float
}

extension GpuLiveDriver {
  /// Replace the open session's pixels when only the decode generation
  /// moved: same dims, crop and input shape, and nothing being opened or
  /// torn down. Presents already queued for the old pixels are superseded
  /// first. `false` means `open` must reopen as before.
  func replaceUploadedImage(
    width: Int, height: Int, inputShape: UInt32, identity: GpuUploadIdentity,
    exports: GpuUploadExports, wbFrame: WbSliderFrame?,
    pixels: @escaping @Sendable () throws -> [Float]
  ) async throws -> Bool {
    guard let s = session, sessionPreparation == nil, sessionTeardown == nil,
      let dims = sessionDims, dims.width == width, dims.height == height,
      let uploaded = uploadedIdentity, uploaded.crop == identity.crop,
      inputShape == self.inputShape
    else { return false }
    let revision = sessionRevision
    guard await s.accepts(width: width, height: height, exports: exports) else { return false }
    guard revision == sessionRevision, session === s else { throw CancellationError() }
    inFlightCancel?.requestCancel()
    let data: [Float]
    do {
      data = try await Task.detached(priority: .userInitiated) { try pixels() }.value
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      // As a reopen does: a failed readback leaves no stale upload claiming coverage.
      if revision == sessionRevision { await closeSession() }
      throw error
    }
    try Task.checkCancellation()
    guard revision == sessionRevision, session === s else { throw CancellationError() }
    let replaced = try await s.replaceImage(
      pixels: data, width: width, height: height, exports: exports)
    guard replaced else { return false }
    guard revision == sessionRevision, session === s else { throw CancellationError() }
    uploadedIdentity = identity
    uploadedWbFrame = wbFrame
    return true
  }
}
