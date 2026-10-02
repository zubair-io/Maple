import CoreImage
import Foundation
import ImageIO
import RawPipeline
import os

private let cameraPreviewLogger = Logger(
  subsystem: "app.justmaple.aperture", category: "CameraPreview")

extension ThumbnailLoader {
  private static let cameraEncodeContext = CIContext()

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
    return ThumbnailEncoder.encode(scaled, ctx: cameraEncodeContext, quality: quality)
  }

  /// First pixels for a cold RAW, before reading or developing its sidecar.
  /// This temporary camera rendering never enters the edited derivative caches.
  /// Grid and Preview share the same extraction and in-flight request.
  public func loadCameraPreview(for asset: AssetRef) async -> Data? {
    guard let url = asset.primaryURL, asset.isRaw else { return nil }
    if let cached = await ThumbnailDiskCache.shared.thumbnailData(for: url),
      Self.isUsableImageData(cached)
    {
      return nil
    }

    let key = "camera-preview:" + url.absoluteString
    if let existing = inFlight[key] { return await existing.value }
    let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
    let gate = cameraPreviewGate
    let task = Task.detached(priority: .userInitiated) { () -> Data? in
      do { try await gate.acquire() } catch { return nil }
      let accessing = scope.startAccessingSecurityScopedResource()
      let data = Task.isCancelled ? nil : Self.embeddedCameraJPEG(at: url)
      if accessing { scope.stopAccessingSecurityScopedResource() }
      await gate.release()
      return data
    }
    inFlight[key] = task
    let data = await task.value
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
