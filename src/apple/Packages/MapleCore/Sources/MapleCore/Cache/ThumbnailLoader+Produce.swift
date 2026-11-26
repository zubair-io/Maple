import AVFoundation
import Foundation
import ImageIO
import os

extension ThumbnailLoader {
  /// The produce path behind the URL-keyed `load`: asset-relative
  /// `.maple/thumbs`, video poster, stub/audio bail, embedded-preview fast
  /// path, Rust-develop slow path. Runs on a detached task under the
  /// decode-slot gate, with the security scope claimed for its full span.
  nonisolated static func produceThumbnail(
    loader: ThumbnailLoader, assetURL: URL, scope: URL
  ) async -> Data? {
    guard !Task.isCancelled else { return nil }
    let accessing = scope.startAccessingSecurityScopedResource()
    defer { if accessing { scope.stopAccessingSecurityScopedResource() } }

    // Retry under the claimed scope, using the same original/XMP freshness
    // gate as step 1. A raw derivative read here would re-stamp stale bytes
    // after an external sidecar change (#5346).
    // A broken shared derivative is removed here, so the source regenerates it.
    if let data = await decodableCachedThumbnail(for: assetURL) {
      guard !Task.isCancelled else { return nil }
      return data
    }

    // VIDEO PATH — extract a poster frame via AVFoundation (#1642).
    // Checked AFTER the .maple/thumbs cache lookup above so a pre-written
    // poster is served from disk without touching AVFoundation again.
    // Short-circuits BEFORE CGImageSourceCreateThumbnailAtIndex so video
    // container bytes are never fed to ImageIO or libraw.
    if SidecarPath.isVideo(assetURL) {
      guard let data = await posterAVIF(at: assetURL) else {
        thumbnailLoaderLogger.warning(
          "video poster extraction failed for \(assetURL.lastPathComponent, privacy: .public)")
        return nil
      }
      thumbnailLoaderLogger.debug(
        "video poster extracted for \(assetURL.lastPathComponent, privacy: .public)")
      guard !Task.isCancelled else { return nil }
      await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
      return data
    }

    // STUB / AUDIO PATH — metadata-only formats with no decode path
    // at all (eip/braw/afphoto/ai stub images, mp3/wav/m4a/aac audio;
    // #1835). No thumbnail is generated — the grid shows filename/
    // size/date with a generic stub badge instead. Short-circuits
    // BEFORE the embedded-preview / Rust-develop paths below so these
    // never reach ImageIO or libraw.
    let ext = assetURL.pathExtension.lowercased()
    if StubExtensions.all.contains(ext) || AudioExtensions.all.contains(ext) {
      return nil
    }

    // A sidecar on either RAW or non-RAW sources is authoritative. Rebuild
    // authored pixels before trying a camera-original thumbnail (#3973/#5346).
    let sourceSignature = LocalDerivativeSourceStamp.signature(for: assetURL)
    if NonRawImageExtensions.all.contains(ext) {
      do {
        if let data = try await renderNonRawSidecarDerivative(
          at: assetURL,
          targetLongEdge: CGFloat(MapleThumbCacheKey.onShareThumbLongEdgePx),
          quality: MapleThumbCacheKey.onShareThumbAVIFQuality
        ) {
          return await ThumbnailDiskCache.shared.storeThumbnailDataIfCurrent(
            data, for: assetURL, sourceSignature: sourceSignature) ? data : nil
        }
      } catch {
        thumbnailLoaderLogger.error(
          "non-RAW sidecar thumbnail failed for \(assetURL.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)"
        )
        return nil
      }
    } else {
      do {
        if Self.hasRawSidecar(at: assetURL),
          let data = try await loader.developRawSidecar(
            at: assetURL,
            targetLongEdge: CGFloat(MapleThumbCacheKey.onShareThumbLongEdgePx),
            quality: MapleThumbCacheKey.onShareThumbAVIFQuality
          )
        {
          return await ThumbnailDiskCache.shared.storeThumbnailDataIfCurrent(
            data, for: assetURL, sourceSignature: sourceSignature) ? data : nil
        }
      } catch is CancellationError {
        return nil
      } catch {
        thumbnailLoaderLogger.error(
          "RAW sidecar thumbnail failed for \(assetURL.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)"
        )
        return nil
      }
    }
    guard LocalDerivativeSourceStamp.matches(sourceSignature, for: assetURL) else { return nil }

    // FAST PATH — the shared Rust extractor reads the camera JPEG for
    // RAWs; ImageIO handles ordinary bitmaps. Neither synthesizes an
    // Apple RAW develop. The sidecar gate above preserves authored edits.
    let t0 = Date()
    if let data = embeddedPreviewAVIF(at: assetURL) {
      let ms = Int(Date().timeIntervalSince(t0) * 1000)
      thumbnailLoaderLogger.debug(
        "thumb fast-path \(assetURL.lastPathComponent, privacy: .public) \(ms)ms")
      guard !Task.isCancelled else { return nil }
      await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
      return data
    }
    thumbnailLoaderLogger.warning(
      "thumb fast-path MISS for \(assetURL.lastPathComponent, privacy: .public) — falling through to slow path"
    )

    // SLOW PATH — no embedded preview. Non-RAW bitmaps (imported JPEG/
    // PNG/HEIF, stitched pano PNGs) already carry demosaiced sRGB /
    // Display-P3 pixels, so they decode via ImageIO directly instead of
    // the RAW developer — `PipelineRenderer.render(rawPath:)` only
    // understands camera RAW containers and throws on these, which used
    // to surface as a blank grey grid tile (#1366). Everything else
    // (the actual `RAWExtensions.all` set, plus unrecognised
    // extensions — same "assume RAW" default as `AssetRef.isRaw`) keeps
    // the full develop + downscale path.
    if NonRawImageExtensions.all.contains(ext) {
      guard let data = nonRawSlowPathAVIF(at: assetURL) else {
        thumbnailLoaderLogger.warning(
          "non-RAW slow-path decode failed for \(assetURL.lastPathComponent, privacy: .public)")
        return nil
      }
      let ms = Int(Date().timeIntervalSince(t0) * 1000)
      thumbnailLoaderLogger.debug(
        "thumb non-RAW slow-path \(assetURL.lastPathComponent, privacy: .public) \(ms)ms")
      guard !Task.isCancelled else { return nil }
      await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
      return data
    }

    do {
      guard let data = try await loader.developFallbackThumbnail(at: assetURL) else {
        thumbnailLoaderLogger.warning(
          "AVIF encode failed for \(assetURL.lastPathComponent, privacy: .public)")
        return nil
      }
      guard !Task.isCancelled else { return nil }
      await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
      return data
    } catch is CancellationError {
      return nil
    } catch {
      thumbnailLoaderLogger.error(
        "pipeline render failed for \(assetURL.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)"
      )
      return nil
    }
  }
}
