// GPU-live presents do not materialize a CIImage. Reuse the existing awaited
// editor-exit readback for thumbnails, display preview and rendered-preview
// cache (#1665, #1879, #2009, #3363). No readback is queued at cold-open readiness.

import CoreImage
import Foundation

@MainActor
extension EditSession {
  /// Refresh the browse/Preview thumbnail + persist the display preview from
  /// the CURRENT GPU frame (#1879, #2009). The GPU-live present path returns
  /// from `decodeAndRender` before the CPU publish tail ever runs, so
  /// GPU-live edits never reach `ThumbnailLoader.updateThumbnailFromRender`
  /// (the browse grid + Preview would keep the pre-edit render) nor
  /// `scheduleDisplayPreviewPersist` (the `<filename>.avif` would stay the
  /// camera original). Called on editor dismiss: ONE utility-priority
  /// readback per editor exit, never at cold-open readiness or per slider tick.
  /// The same bytes also populate the rendered-preview cache. No-op when the
  /// GPU path never presented for this canvas (the CPU publish tail already
  /// refreshed both on every refine) or without a driver.
  ///
  /// The thumbnail refresh needs a local URL and is skipped for cloud assets
  /// (their grid thumbs are server-rendered); the preview persist runs for
  /// both — a local file write or an `/api/preview` upload via `previewSink`.
  ///
  /// `async` + strong `self`, and it AWAITS the off-actor encode/write: this
  /// is the teardown path, so the caller must be able to keep the session (and
  /// on iOS the app) alive until the write lands. A fire-and-forget
  /// `Task { [weak self] … }` would drop the final frame if the session
  /// deallocated on exit or the app suspended (jules review, #2009).
  public func refreshThumbnailFromCurrentGpuFrame() async {
    await refreshThumbnailFromCurrentGpuFrame(expectedModel: model)
  }

  func refreshThumbnailFromCurrentGpuFrame(expectedModel capturedModel: AdjustmentModel) async {
    guard gpuFramePresented, let driver = gpuLiveDriver else { return }
    // A crop/baked edit can still be waiting for admission when the editor
    // disappears. Join that work, then validate the actual uploaded pixels.
    _ = await latestRenderSchedule?.value
    await renderActor.awaitCurrentRenderIfInFlight()
    let snapshot = await renderActor.snapshot(forAsset: asset)
    let resolvedIsRaw = await renderActor.resolvedIsRaw(for: asset.id) ?? asset.isRaw
    let identity = GpuUploadIdentity(
      decodeGeneration: snapshot.decodeGeneration, crop: capturedModel.crop)
    guard model == capturedModel, !isFullQualityDecoding, !gpuPresentFailed,
      snapshot.image != nil, snapshot.isFresh,
      !resolvedIsRaw
        || (snapshot.profile == capturedModel.profile
          && snapshot.autoExposure == capturedModel.autoExposure),
      driver.isOpen(coveringWidth: 1, height: 1, identity: identity)
    else { return }
    let liveSession = driver.session
    let thumbnailURL = asset.primaryURL
    let screenWidth = Int(max(previewSize.width, 1))
    let cacheWrite: RenderedPreviewCache.WriteSnapshot?
    if let thumbnailURL {
      cacheWrite = await RenderedPreviewCache.shared.captureWrite(
        for: thumbnailURL, screenWidth: screenWidth)
    } else {
      cacheWrite = nil
    }
    guard model == capturedModel, liveSession === driver.session else { return }
    // Same WB anchor as the live present; readback reruns that chain.
    let liveWbFrame = resolvedIsRaw ? wbSliderFrame : nil
    let anchor = wbDeltaAnchor
    let cct = resolvedIsRaw ? (anchor?.temperature ?? asShotCCT) : 6500.0
    let tint = resolvedIsRaw ? (anchor?.tint ?? asShotTint) : 0.0
    guard
      let frame = await driver.renderCurrentFrameBytes(
        model: capturedModel,
        asShotCCT: cct,
        asShotTint: tint,
        wbFrame: liveWbFrame
      )
    else { return }
    guard model == capturedModel, driver === gpuLiveDriver,
      liveSession === driver.session, !gpuPresentFailed
    else { return }
    let sink = previewSink
    let stillCurrent: @MainActor @Sendable () -> Bool = {
      self.model == capturedModel && driver === self.gpuLiveDriver
        && liveSession === driver.session && !self.gpuPresentFailed
    }
    // Off the MainActor (per-pixel RGBA expansion + AVIF encode), but
    // AWAITED so the exit path knows the write completed.
    await Task.detached(priority: .utility) {
      guard
        let image = Self.ciImageFromGpuRgb(
          frame.bytes, width: frame.width, height: frame.height
        )
      else { return }
      // Rendering/encoding may have scheduled another CPU preview since the
      // initial exit drain. Join it before accepting the current GPU image.
      guard await self.cancelAndJoinDisplayPreviewPersist(expectedModel: capturedModel) else {
        return
      }
      let accepted = await MainActor.run {
        guard stillCurrent() else { return false }
        // Conversion succeeded; keep the CPU fallback until this point.
        self.pendingPreviewImage = nil
        return true
      }
      guard accepted else { return }
      if let cacheWrite {
        guard await stillCurrent() else { return }
        await RenderedPreviewCache.shared.storePreview(image, for: cacheWrite)
      }
      if let thumbnailURL {
        guard await stillCurrent() else { return }
        await ThumbnailLoader.shared.updateThumbnailFromRender(image, for: thumbnailURL)
      }
      if let sink, let data = ThumbnailLoader.encodeDisplayPreview(from: image) {
        guard await stillCurrent() else { return }
        await sink.write(data)
      }
    }.value
  }

  /// Wrap the GPU chain's `width·height·3` u8 RGB readback (the canonical
  /// `dither_and_quantize` layout — sRGB-primary gamma-encoded, since the live
  /// params hardcode `target_primaries = 0`) into a CIImage for the preview
  /// cache. Expands RGB→RGBA (CIImage has no 3-channel bitmap format; alpha is
  /// opaque) and tags **sRGB** to match the chain output, so the cache's sRGB
  /// JPEG encode is an identity colour conversion. Pure → unit-testable; returns
  /// `nil` on a degenerate size or a `count != width·height·3` mismatch.
  nonisolated static func ciImageFromGpuRgb(_ rgb: [UInt8], width: Int, height: Int) -> CIImage? {
    let pixelCount = width * height
    guard width > 0, height > 0, rgb.count == pixelCount * 3,
      let space = CGColorSpace(name: CGColorSpace.sRGB)
    else { return nil }
    // CIImage has no 3-channel bitmap format — expand RGB → opaque RGBA.
    var rgba = [UInt8](repeating: 255, count: pixelCount * 4)
    for i in 0..<pixelCount {
      rgba[i * 4 + 0] = rgb[i * 3 + 0]
      rgba[i * 4 + 1] = rgb[i * 3 + 1]
      rgba[i * 4 + 2] = rgb[i * 3 + 2]
      // alpha stays 255 (the chain output is opaque)
    }
    return CIImage(
      bitmapData: Data(rgba),
      bytesPerRow: width * 4,
      size: CGSize(width: width, height: height),
      format: .RGBA8,
      colorSpace: space
    )
  }
}
