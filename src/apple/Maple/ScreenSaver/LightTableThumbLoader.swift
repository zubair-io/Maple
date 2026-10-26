// LightTableThumbLoader.swift — thumbnails for the backup screen saver's
// Light Table (#5457). The Light Table fetches and decodes each print before
// it glides in, so the print's image is a synchronous lookup by then.

#if os(iOS)
  import ImageIO
  import MapleCore
  import SwiftUI
  import UIKit

  @MainActor
  final class LightTableThumbLoader {
    private let server: URL
    private let client: CloudThumbClient
    private let cache: CloudThumbCache
    private let decoded: NSCache<NSString, UIImage> = {
      let cache = NSCache<NSString, UIImage>()
      cache.countLimit = 64
      return cache
    }()

    init(server: URL, client: CloudThumbClient, cache: CloudThumbCache) {
      self.server = server
      self.client = client
      self.cache = cache
    }

    func image(for asset: SearchAsset) -> UIImage? {
      decoded.object(forKey: asset.abs_path as NSString)
    }

    /// Fetch and decode the thumbnail, falling back to the preview tier when
    /// the server has no thumbnail yet (a freshly uploaded photo).
    func prefetch(_ asset: SearchAsset) async {
      guard image(for: asset) == nil else { return }
      let thumb = await fetchCloudThumbBytes(
        host: server.cacheHostKey, absPath: asset.abs_path, cache: cache, client: client)
      let bytes = if let thumb { thumb } else { try? await client.preview(absPath: asset.abs_path) }
      guard let bytes, !Task.isCancelled, let image = await Self.decode(bytes), !Task.isCancelled
      else { return }
      decoded.setObject(image, forKey: asset.abs_path as NSString)
    }

    private nonisolated static func decode(_ data: Data) async -> UIImage? {
      guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
      let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceThumbnailMaxPixelSize: 720,
      ]
      return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        .map { UIImage(cgImage: $0) }
    }
  }

  /// The photo inside a Light Table print's mat. Fit, never cropped, so a
  /// non-square photo sits on the white mat.
  struct LightTablePrintPhoto: View {
    let image: UIImage?

    var body: some View {
      if let image {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
      } else {
        LightTablePalette.paperBottom
      }
    }
  }
#endif
