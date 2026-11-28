import Foundation
import ImageIO
import MapleCloudKit
import SwiftUI

/// Strict 8 MiB LRU of decoded images and the thumbnail bytes they were decoded from, released
/// with the authenticated session. Keeping the bytes lets the photo tier reuse the row tier's
/// download. Keys include server, absolute asset path and mtime. No originals fetched.
actor WatchImageStore {
  enum Tier: String {
    case row, photo
    var pixels: Int { self == .row ? 128 : 512 }
  }

  private enum Payload {
    case image(CGImage)
    case thumbBytes(Data)
  }

  private struct Entry {
    let payload: Payload
    let cost: Int
  }
  private let server: URL
  private let client: CloudThumbClient
  private let permits = BoundedAsyncSemaphore(value: 2)
  private var entries: [String: Entry] = [:]
  private var order: [String] = []
  private var cost = 0
  private var active = true
  private var generation = 0
  private let budget = 8 * 1024 * 1024

  init(server: URL, client: CloudThumbClient) {
    self.server = server
    self.client = client
  }

  func invalidate() {
    active = false
    clear()
  }

  /// Explicit refresh drops stale sidecar-derived pixels without ending this session.
  func clear() {
    generation += 1
    entries.removeAll()
    order.removeAll()
    cost = 0
  }

  func image(for asset: SearchAsset, tier: Tier) async throws -> CGImage {
    // A decoded hit must not wait behind the two network permits.
    if active, let hit = cachedImage(forKey: cacheKey(for: asset, tier: tier)) { return hit }
    let current = generation
    try await permits.acquire()
    do {
      guard current == generation else { throw CancellationError() }
      let result = try await loadImage(for: asset, tier: tier, generation: current)
      await permits.release()
      return result
    } catch {
      await permits.release()
      throw error
    }
  }

  private func loadImage(for asset: SearchAsset, tier: Tier, generation current: Int) async throws
    -> CGImage
  {
    guard active else { throw CancellationError() }
    let key = cacheKey(for: asset, tier: tier)
    if let hit = cachedImage(forKey: key) { return hit }
    let image = try await fetchImage(for: asset, tier: tier, generation: current)
    try Task.checkCancellation()
    guard current == generation else { throw CancellationError() }
    guard active else { throw CancellationError() }
    insert(.image(image), cost: image.bytesPerRow * image.height, forKey: key)
    return image
  }

  private func insert(_ payload: Payload, cost entryCost: Int, forKey key: String) {
    if let prior = entries.removeValue(forKey: key) { cost -= prior.cost }
    order.removeAll { $0 == key }
    while cost + entryCost > budget, let oldest = order.first {
      order.removeFirst()
      if let removed = entries.removeValue(forKey: oldest) { cost -= removed.cost }
    }
    if entryCost <= budget {
      entries[key] = Entry(payload: payload, cost: entryCost)
      order.append(key)
      cost += entryCost
    }
  }

  private func cacheKey(for asset: SearchAsset, tier: Tier) -> String {
    "\(server.absoluteString)|\(asset.abs_path)|\(asset.mtime ?? 0)|thumb-\(tier.rawValue)"
  }

  private func thumbBytesKey(for asset: SearchAsset) -> String {
    "\(server.absoluteString)|\(asset.abs_path)|\(asset.mtime ?? 0)|\(asset.thumb_version ?? "")|thumb-bytes"
  }

  private func cachedEntry(forKey key: String) -> Payload? {
    guard let entry = entries[key] else { return nil }
    order.removeAll { $0 == key }
    order.append(key)
    return entry.payload
  }

  private func cachedImage(forKey key: String) -> CGImage? {
    guard case .image(let image) = cachedEntry(forKey: key) else { return nil }
    return image
  }

  private func cachedThumbBytes(forKey key: String) -> Data? {
    guard case .thumbBytes(let data) = cachedEntry(forKey: key) else { return nil }
    return data
  }

  private func fetchImage(for asset: SearchAsset, tier: Tier, generation current: Int) async throws
    -> CGImage
  {
    let bytesKey = thumbBytesKey(for: asset)
    if let kept = cachedThumbBytes(forKey: bytesKey), let image = try? decode(kept, tier: tier) {
      return image
    }
    do {
      let data = try await client.thumb(absPath: asset.abs_path, version: asset.thumb_version)
      try Task.checkCancellation()
      guard active else { throw CancellationError() }
      let image = try decode(data, tier: tier)
      if current == generation { insert(.thumbBytes(data), cost: data.count, forKey: bytesKey) }
      return image
    } catch {
      try Task.checkCancellation()
      guard active else { throw CancellationError() }
      // Both routes currently serve AVIF. A separately generated preview can recover
      // a missing/bad thumbnail, but does not guarantee support for a missing codec.
      let data = try await client.preview(absPath: asset.abs_path)
      try Task.checkCancellation()
      guard active else { throw CancellationError() }
      return try decode(data, tier: tier)
    }
  }

  private func decode(_ data: Data, tier: Tier) throws -> CGImage {
    guard
      let source = CGImageSourceCreateWithData(
        data as CFData,
        [
          kCGImageSourceShouldCache: false
        ] as CFDictionary),
      let image = CGImageSourceCreateThumbnailAtIndex(
        source, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: tier.pixels,
          kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
    else {
      throw NSError(
        domain: "MapleWatch", code: 1,
        userInfo: [
          NSLocalizedDescriptionKey: "This photo preview could not be decoded on your Watch."
        ])
    }
    return image
  }

}

struct WatchRemoteImage: View {
  let asset: SearchAsset
  let store: WatchImageStore
  var tier: WatchImageStore.Tier = .photo
  @State private var image: CGImage?
  @State private var error: String?
  @State private var attempt = 0
  @State private var generation = 0

  var body: some View {
    Group {
      if let image {
        Image(decorative: image, scale: 1).resizable().scaledToFit()
          .accessibilityLabel(asset.filename)
      } else if let error {
        if tier == .row {
          Image(systemName: "photo.badge.exclamationmark")
            .accessibilityLabel("Preview unavailable. Open photo to retry.")
        } else {
          VStack {
            Text(error).font(.caption2)
            Button("Retry photo") { attempt += 1 }
          }
        }
      } else {
        if tier == .row {
          ProgressView().accessibilityLabel("Loading photo")
        } else {
          ProgressView("Loading photo")
        }
      }
    }
    .task(id: "\(asset.id)-\(attempt)") {
      generation += 1
      let current = generation
      image = nil
      error = nil
      do {
        let loaded = try await store.image(for: asset, tier: tier)
        guard current == generation, !Task.isCancelled else { return }
        image = loaded
      } catch {
        guard current == generation, !Task.isCancelled else { return }
        self.error = error.localizedDescription
      }
    }
  }
}
