// src/apple/Maple TV/TVRemoteImage.swift
import ImageIO
import MapleCloudKit
import SwiftUI
import UIKit

/// Authenticated, cache-first async image view for the connected (cloud)
/// experience. Every cloud image on Maple TV — grid cells, the focused
/// caption, the full-screen viewer — routes through this so bearer auth is
/// never optional: there is no bare `AsyncImage(url:)` anywhere, because
/// `/api/fs/thumb` and `/api/fs/preview` are bearer-gated with no
/// query-token escape hatch (Global Constraint, ticket #2102).
///
/// Fetch order on appear:
///   1. `TVDecodedImageCache` (process-lifetime, already-decoded `UIImage`)
///   2. `CloudThumbCache` (on-disk raw bytes — AVIF for thumbs)
///   3. `CloudThumbClient` (network; bearer injected internally by the
///      client's `AuthenticatedHTTPClient`), then populates both caches.
///
/// `.thumb` and `.preview` intentionally use different byte-caching
/// strategies. `CloudThumbCache` keys ONLY on `(host, absPath)` — there is
/// no size/kind component — so it exists to hold the one small AVIF grid
/// thumbnail per asset the server itself caches
/// (`CloudThumbClient.thumb(absPath:size:)`'s doc comment: a larger `size`
/// just returns that same cached file). Routing `.preview`'s much larger
/// ~1280px JPEG through the same disk slot would silently evict/replace the
/// grid thumbnail bytes with preview bytes (or vice versa) any time both
/// tiers are requested for the same asset — exactly the collision
/// `ThumbnailProvider.preview(for:)` on iOS was written to avoid ("this
/// deliberately bypasses the thumbnail caches"). `TVRemoteImage` mirrors
/// that established split: `.thumb` is cache-first through
/// `CloudThumbCache`; `.preview` always calls `CloudThumbClient.preview`
/// directly and is never written to `CloudThumbCache` (it still benefits
/// from `TVDecodedImageCache` once decoded, so revisiting a full-screen
/// asset in the same session doesn't refetch).
struct TVRemoteImage: View {
  /// Which server-side tier to fetch. `.thumb` is the AVIF grid thumbnail
  /// (`GET /api/fs/thumb`); `.preview` is the ~1280px JPEG display tier
  /// (`GET /api/fs/preview`).
  enum Kind: Hashable {
    case thumb(size: Int = 512)
    case preview

    fileprivate var decodedCacheSuffix: String {
      switch self {
      case .thumb(let size): return "thumb:\(size)"
      case .preview: return "preview"
      }
    }
  }

  let server: URL
  let absPath: String
  let kind: Kind
  let thumbClient: CloudThumbClient
  let thumbCache: CloudThumbCache

  /// `.fill` (crop-to-fill) is the grid-cell default. The full-screen
  /// viewer passes `.fit` so the whole preview frame is visible.
  var contentMode: ContentMode = .fill

  /// Falls back to the abs path's last component (the filename) when the
  /// caller doesn't have a richer caption yet — every focusable/visual
  /// element must carry a label (Global Constraint: Accessibility).
  var accessibilityLabel: String?

  private enum Phase {
    case loading
    case loaded(UIImage)
    case failed
  }

  @State private var phase: Phase = .loading

  var body: some View {
    Rectangle()
      .fill(Color.clear)
      .overlay {
        switch phase {
        case .loading:
          MapleTVTheme.surface
        case .loaded(let image):
          Image(uiImage: image)
            .resizable()
            .aspectRatio(contentMode: contentMode)
        case .failed:
          MapleTVTheme.surface
            .overlay {
              Image(systemName: "photo")
                .foregroundStyle(MapleTVTheme.textMuted)
            }
        }
      }
      .clipped()
      // `.task(id:)` cancels the prior in-flight fetch whenever `cacheKey`
      // changes (a reused cell whose `absPath`/`kind` changed) or the view
      // leaves the hierarchy (a cell scrolled off before its fetch
      // completed) — the two correctness requirements this view has to
      // satisfy: no stale image after reuse, no thrash from an orphaned
      // fetch. Resetting `phase` to `.loading` up front means a reused
      // cell never shows the PREVIOUS asset's pixels while the new one
      // loads.
      .task(id: cacheKey) {
        phase = .loading
        await load()
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(accessibilityLabel ?? fallbackAccessibilityLabel)
  }

  private var cacheKey: String {
    "\(server.cacheHostKey)|\(absPath)|\(kind.decodedCacheSuffix)"
  }

  private var fallbackAccessibilityLabel: String {
    (absPath as NSString).lastPathComponent
  }

  private func load() async {
    if let cached = TVDecodedImageCache.shared.image(forKey: cacheKey) {
      phase = .loaded(cached)
      return
    }

    guard let data = await fetchBytes() else {
      guard !Task.isCancelled else { return }
      phase = .failed
      return
    }
    guard !Task.isCancelled else { return }

    guard let cgImage = Self.decode(data) else {
      guard !Task.isCancelled else { return }
      phase = .failed
      return
    }
    let image = UIImage(cgImage: cgImage)
    TVDecodedImageCache.shared.setImage(image, forKey: cacheKey)
    guard !Task.isCancelled else { return }
    phase = .loaded(image)
  }

  private func fetchBytes() async -> Data? {
    let host = server.cacheHostKey
    switch kind {
    case .thumb(let size):
      if let cached = await thumbCache.get(host: host, absPath: absPath) {
        return cached
      }
      guard let bytes = try? await thumbClient.thumb(absPath: absPath, size: size) else {
        return nil
      }
      guard !Task.isCancelled else { return nil }
      await thumbCache.put(host: host, absPath: absPath, bytes)
      return bytes

    case .preview:
      return try? await thumbClient.preview(absPath: absPath)
    }
  }

  /// Decode image bytes to a `CGImage` (format-agnostic via
  /// `CGImageSource` — AVIF thumbs and JPEG previews both go through this
  /// same path). tvOS 16+ decodes AVIF natively through ImageIO, so no
  /// format-specific branch or fallback is needed here.
  private static func decode(_ data: Data) -> CGImage? {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else { return nil }
    return img
  }
}

/// Process-lifetime cache of already-decoded images, keyed on
/// `(server, absPath, kind)`. `CloudThumbCache` only persists raw bytes to
/// disk, so without this every focus scroll-back through a cell that has
/// already displayed its thumbnail would re-run the `CGImageSourceCreate*`
/// decode. `NSCache` is thread-safe and evicts under memory pressure, so
/// concurrent `.task(id:)` fetches from scrolling cells can read/write it
/// without extra locking.
final class TVDecodedImageCache {
  static let shared = TVDecodedImageCache()

  private let cache = NSCache<NSString, UIImage>()

  private init() {
    // Generous relative to what's ever on screen at once (a Timeline row
    // is a handful of cells) plus a scroll buffer either side; this is a
    // memory-pressure-evicted cache, not a hard budget.
    cache.countLimit = 400
  }

  func image(forKey key: String) -> UIImage? {
    cache.object(forKey: key as NSString)
  }

  func setImage(_ image: UIImage, forKey key: String) {
    cache.setObject(image, forKey: key as NSString)
  }
}
