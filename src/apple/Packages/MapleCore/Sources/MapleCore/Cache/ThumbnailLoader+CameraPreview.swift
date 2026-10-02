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
    guard let bytes = embeddedCameraJPEG(at: url),
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
  public func loadCameraPreview(for asset: AssetRef) async -> Data? {
    guard !Task.isCancelled, let url = asset.primaryURL, asset.isRaw else { return nil }
    if let cached = await ThumbnailDiskCache.shared.thumbnailData(for: url),
      Self.isUsableImageData(cached)
    {
      return nil
    }

    guard !Task.isCancelled else { return nil }
    let key = "camera-preview:" + url.absoluteString
    if let existing = inFlight[key] {
      return await ThumbnailFetchGate.awaitCancellably(existing)
    }
    let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
    let gate = cameraPreviewGate
    let task = Task.detached(priority: .userInitiated) { () -> Data? in
      do { try await gate.acquire() } catch { return nil }
      let accessing = scope.startAccessingSecurityScopedResource()
      let data = Task.isCancelled ? nil : Self.embeddedCameraJPEG(at: url)
      if accessing { scope.stopAccessingSecurityScopedResource() }
      await gate.release()
      // The synchronous Rust extractor cannot be interrupted mid-call.
      // Always release its permit, then discard canceled extraction results.
      return Task.isCancelled ? nil : data
    }
    inFlight[key] = task
    let data = await ThumbnailFetchGate.awaitCancellably(task)
    if inFlight[key] == task { inFlight.removeValue(forKey: key) }
    return data
  }

  /// Use the canonical Rust preview extractor rather than asking ImageIO to
  /// synthesize a full Apple RAW render. The FFI owns orientation and the
  /// format-specific preview-slot hunt, including containers ImageIO misses.
  nonisolated static func embeddedCameraJPEG(at url: URL) -> Data? {
    let output = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-camera-preview-\(UUID().uuidString).jpg")
    defer {
      try? FileManager.default.removeItem(at: output)
      try? FileManager.default.removeItem(atPath: output.path + ".tmp")
    }
    let result = url.path.withCString { rawPath in
      output.path.withCString { outPath in
        maple_render_thumbnail_preview_jpeg_to_file(
          rawPath, outPath, UInt32(displayPreviewLongEdge), 85)
      }
    }
    guard result == 0,
      let data = try? Data(contentsOf: output), isUsableImageData(data)
    else {
      cameraPreviewLogger.warning(
        "embedded preview unavailable for \(url.lastPathComponent, privacy: .public) (code \(result))"
      )
      return nil
    }
    return data
  }
}
