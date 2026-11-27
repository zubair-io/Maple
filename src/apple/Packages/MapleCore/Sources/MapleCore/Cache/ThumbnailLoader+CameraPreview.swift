import CoreImage
import Foundation
import ImageIO
import RawPipeline
import os

private let cameraPreviewLogger = Logger(
  subsystem: "app.justmaple.aperture", category: "CameraPreview")

extension ThumbnailLoader {
  /// Extract camera pixels through the shared Rust core for RAWs, or
  /// ImageIO for regular bitmaps, and encode the canonical AVIF grid tier.
  nonisolated static func embeddedPreviewAVIF(at url: URL) -> Data? {
    if !NonRawImageExtensions.all.contains(url.pathExtension.lowercased()) {
      return embeddedCameraAVIF(
        at: url, targetLongEdge: CGFloat(MapleThumbCacheKey.onShareThumbLongEdgePx),
        quality: MapleThumbCacheKey.onShareThumbAVIFQuality)
    }
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let targetPx = Int(ThumbnailDiskCache.defaultThumbSize.width * 2)  // 2x for Retina
    let opts: [CFString: Any] = [
      // Prefer an existing embedded thumbnail; fall back to a new one
      // generated from the full image if none is present.
      kCGImageSourceCreateThumbnailFromImageAlways: false,
      kCGImageSourceCreateThumbnailFromImageIfAbsent: true,
      kCGImageSourceThumbnailMaxPixelSize: targetPx,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCache: false,
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
      return nil
    }
    // Encode to AVIF at spec quality via CIContext (reuses GPU path).
    let ci = CIImage(cgImage: cg)
    return thumbnailData(from: ci, ctx: staticEncodeCIContext)
  }

  /// Both persisted tiers use the same embedded JPEG and AVIF encoder.
  /// Only call this after the sidecar gate permits a camera derivative.
  nonisolated static func embeddedCameraAVIF(
    at url: URL, targetLongEdge: CGFloat, quality: CGFloat
  ) -> Data? {
    let seeded =
      cameraPreviewCache.object(
        forKey: ThumbnailDiskCache.memoryKey(for: url) as NSString) as Data?
    guard let bytes = seeded ?? embeddedCameraJPEG(at: url),
      let source = CGImageSourceCreateWithData(bytes as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { return nil }
    let scale = min(1, targetLongEdge / CGFloat(max(image.width, image.height)))
    let scaled = CIImage(cgImage: image)
      .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    return ThumbnailEncoder.encode(scaled, ctx: staticEncodeCIContext, quality: quality)
  }

  /// First pixels for a cold RAW, before reading or developing its sidecar.
  /// This temporary camera rendering never enters the edited derivative caches.
  /// Grid and Preview share the same extraction and in-flight request.
  ///
  /// Nonisolated for the same reason as `load(for:scopeParentURL:)`: every
  /// RAW cell asks this first, and a warm thumbnail answers it off the actor.
  public nonisolated func loadCameraPreview(for asset: AssetRef) async -> Data? {
    guard !Task.isCancelled, let url = asset.primaryURL, asset.isRaw else { return nil }
    if await Self.decodableCachedThumbnail(for: url) != nil { return nil }
    guard !Task.isCancelled else { return nil }
    return await joinCameraPreview(for: asset, url: url)
  }

  private func joinCameraPreview(for asset: AssetRef, url: URL) async -> Data? {
    let cacheKey = ThumbnailDiskCache.memoryKey(for: url) as NSString
    if let cached = Self.cameraPreviewCache.object(forKey: cacheKey) as Data? {
      return cached
    }
    let key = "camera-preview:" + url.absoluteString
    let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
    let task = cameraPreviewTask(key: key, cacheKey: cacheKey, url: url, scope: scope)
    let waiter = UUID()
    cameraPreviewWaiters[key, default: []].insert(waiter)
    let data = await withTaskCancellationHandler {
      await task.value
    } onCancel: {
      Task { await self.removeCameraPreviewWaiter(key: key, waiter: waiter, task: task) }
    }
    removeCameraPreviewWaiter(key: key, waiter: waiter, task: task)
    return Task.isCancelled ? nil : data
  }

  private func cameraPreviewTask(
    key: String, cacheKey: NSString, url: URL, scope: URL
  ) -> Task<Data?, Never> {
    if let existing = inFlight[key], !existing.isCancelled { return existing }
    let gate = cameraPreviewGate
    let cache = Self.cameraPreviewCache
    let task = Task.detached(priority: .userInitiated) { () -> Data? in
      do { try await gate.acquire() } catch { return nil }
      let accessing = scope.startAccessingSecurityScopedResource()
      let data = Task.isCancelled ? nil : Self.embeddedCameraJPEG(at: url)
      if accessing { scope.stopAccessingSecurityScopedResource() }
      if let data {
        cache.setObject(data as NSData, forKey: cacheKey)
      }
      await gate.release()
      // The synchronous Rust extractor cannot be interrupted mid-call.
      // Always release its permit, then discard canceled extraction results.
      return Task.isCancelled ? nil : data
    }
    inFlight[key] = task
    cameraPreviewWaiters[key] = []
    return task
  }

  /// A disappearing grid cell must not cancel a coalesced Preview request.
  /// Remove each waiter once; cancel queued extraction when nobody needs it.
  private func removeCameraPreviewWaiter(
    key: String, waiter: UUID, task: Task<Data?, Never>
  ) {
    guard inFlight[key] == task,
      cameraPreviewWaiters[key]?.remove(waiter) != nil,
      cameraPreviewWaiters[key]?.isEmpty == true
    else { return }
    cameraPreviewWaiters.removeValue(forKey: key)
    inFlight.removeValue(forKey: key)
    task.cancel()
  }

  /// Use the canonical Rust preview extractor rather than asking ImageIO to
  /// synthesize a full Apple RAW render. The FFI owns orientation and the
  /// format-specific preview-slot hunt, including containers ImageIO misses.
  nonisolated static func embeddedCameraJPEG(
    at url: URL, initialCapacity: Int = cameraPreviewInitialBufferBytes
  ) -> Data? {
    let capacity = max(1, initialCapacity)
    let first = cameraPreviewAttempt(at: url, capacity: capacity)
    let grown = first.code == cameraPreviewBufferTooSmall && first.needed > capacity
    let attempt = grown ? cameraPreviewAttempt(at: url, capacity: first.needed) : first
    guard let data = attempt.data, isUsableImageData(data) else {
      cameraPreviewLogger.warning(
        "embedded preview unavailable for \(url.lastPathComponent, privacy: .public) (code \(attempt.code))"
      )
      return nil
    }
    return data
  }

  private nonisolated static func cameraPreviewAttempt(
    at url: URL, capacity: Int
  ) -> (code: Int32, needed: Int, data: Data?) {
    let output = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
    defer { output.deallocate() }
    var written: UInt = 0
    let code = url.path.withCString { rawPath in
      maple_render_thumbnail_preview_jpeg_buf(
        rawPath, UInt32(displayPreviewLongEdge), 85, output, UInt(capacity), &written)
    }
    let needed = Int(written)
    let data = code == 0 && needed <= capacity ? Data(bytes: output, count: needed) : nil
    return (code, needed, data)
  }

  /// The core re-extracts on every call, so a size probe would double the
  /// work. A noisy 1280 px preview at full chroma resolution stays under this.
  nonisolated static let cameraPreviewInitialBufferBytes = 2 << 20
  /// `NEED_LARGER_BUFFER` in raw-ffi's `thumbnail.rs`.
  private nonisolated static let cameraPreviewBufferTooSmall: Int32 = 100
}
