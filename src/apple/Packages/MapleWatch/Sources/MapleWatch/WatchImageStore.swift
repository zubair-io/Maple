import Foundation
import ImageIO
import MapleCloudKit
import SwiftUI

/// Strict 8 MiB decoded-image LRU, released with the authenticated session.
/// Key includes server, absolute asset path, mtime and derivative tier. No originals fetched.
actor WatchImageStore {
  enum Tier: String {
    case row, photo
    var pixels: Int { self == .row ? 128 : 512 }
  }

  private struct Entry {
    let image: CGImage
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
    let key =
      "\(server.absoluteString)|\(asset.abs_path)|\(asset.mtime ?? 0)|thumb-\(tier.rawValue)"
    if let entry = entries[key] {
      order.removeAll { $0 == key }
      order.append(key)
      return entry.image
    }
    let image = try await fetchImage(for: asset, tier: tier)
    try Task.checkCancellation()
    guard current == generation else { throw CancellationError() }
    guard active else { throw CancellationError() }
    let imageCost = image.bytesPerRow * image.height
    if let prior = entries.removeValue(forKey: key) { cost -= prior.cost }
    order.removeAll { $0 == key }
    while cost + imageCost > budget, let oldest = order.first {
      order.removeFirst()
      if let removed = entries.removeValue(forKey: oldest) { cost -= removed.cost }
    }
    if imageCost <= budget {
      entries[key] = Entry(image: image, cost: imageCost)
      order.append(key)
      cost += imageCost
    }
    return image
  }

  private func fetchImage(for asset: SearchAsset, tier: Tier) async throws -> CGImage {
    do {
      let data = try await client.thumb(absPath: asset.abs_path)
      try Task.checkCancellation()
      guard active else { throw CancellationError() }
      return try decode(data, tier: tier)
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
