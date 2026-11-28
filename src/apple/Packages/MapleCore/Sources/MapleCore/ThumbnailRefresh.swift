// ThumbnailRefresh.swift — a cloud thumbnail replaced in the background is
// broadcast by its cache key, so every cell showing that photo, now or created
// later, ends up with the new pixels.

import Combine
import CoreGraphics
import Foundation

public enum ThumbnailRefresh {
  public static let didRefresh = Notification.Name("app.justmaple.thumbnailDidRefresh")

  private static let keyUserInfo = "thumbnailKey"
  private static let trackedAssetCapacity = 1024

  private final class Registry: @unchecked Sendable {
    private let lock = NSLock()
    private var bitmapKeysByAsset = RecencyOrderedStore<String, Set<String>>(
      capacity: ThumbnailRefresh.trackedAssetCapacity)

    /// Returns the bitmap keys of the photo that fell out of the registry, which
    /// no refresh can reach any more.
    func track(_ bitmapKey: String, forAsset assetKey: String) -> [String] {
      lock.withLock {
        let known = bitmapKeysByAsset.touch(assetKey)
        let forgotten =
          known == nil && bitmapKeysByAsset.count >= ThumbnailRefresh.trackedAssetCapacity
          ? bitmapKeysByAsset.oldestKey.flatMap { bitmapKeysByAsset.peek($0) } ?? [] : []
        bitmapKeysByAsset.set((known ?? []).union([bitmapKey]), for: assetKey)
        return Array(forgotten)
      }
    }

    func bitmapKeys(forAsset assetKey: String) -> [String] {
      lock.withLock { Array(bitmapKeysByAsset.peek(assetKey) ?? []) }
    }
  }

  private static let registry = Registry()

  /// A cell calls this before it decodes under `bitmapKey`, so a later refresh
  /// of the photo replaces that bitmap too.
  public static func track(bitmapKey: String, for source: ThumbnailSource) {
    guard let assetKey = source.refreshKey else { return }
    ThumbnailDecoder.removeImages(forKeys: registry.track(bitmapKey, forAsset: assetKey))
  }

  /// Every refresh, delivered on the main queue; one shared chain for all cells.
  public static let refreshes: AnyPublisher<Notification, Never> =
    NotificationCenter.default.publisher(for: didRefresh)
    .receive(on: DispatchQueue.main)
    .eraseToAnyPublisher()

  /// The bitmap a cell showed, and the load that produced it.
  public struct ShownBitmap: Equatable, Sendable {
    public let loadKey: String
    public let bitmapKey: String

    public init(loadKey: String, bitmapKey: String) {
      self.loadKey = loadKey
      self.bitmapKey = bitmapKey
    }
  }

  /// The bitmap key a cell must refresh for `notification`, or nil when the
  /// event is for another photo or the cell is still switching to `loadKey`.
  public static func bitmapKey(
    toRefresh source: ThumbnailSource, loadKey: String, shown: ShownBitmap?,
    on notification: Notification
  ) -> String? {
    guard reloads(source, on: notification), let shown, shown.loadKey == loadKey else {
      return nil
    }
    return shown.bitmapKey
  }

  /// Replaces every tracked bitmap of the photo with `bytes`, then announces the
  /// refresh. Bytes are already in the thumbnail cache, so a cell created after
  /// this point reads fresh data.
  static func publish(assetKey: String, bytes: Data) async {
    let bitmapKeys = registry.bitmapKeys(forAsset: assetKey)
    if !bitmapKeys.isEmpty { _ = await ThumbnailDecoder.replaceImage(for: bytes, keys: bitmapKeys) }
    NotificationCenter.default.post(
      name: didRefresh, object: nil, userInfo: [keyUserInfo: assetKey])
  }

  /// Whether `notification` announces a refresh of the photo `source` shows.
  public static func reloads(_ source: ThumbnailSource, on notification: Notification) -> Bool {
    guard notification.name == didRefresh, let key = source.refreshKey else { return false }
    return notification.userInfo?[keyUserInfo] as? String == key
  }

  /// The refreshed bitmap for a cell: its bitmap is dropped, whatever the
  /// registry holds, and decoded again from the cached bytes.
  public static func refreshedImage(for source: ThumbnailSource, bitmapKey: String) async
    -> CGImage?
  {
    ThumbnailDecoder.removeImages(forKeys: [bitmapKey])
    guard let assetKey = source.refreshKey,
      let bytes = await ThumbnailDiskCache.shared.thumbnailData(forKey: assetKey)
    else { return nil }
    return await ThumbnailDecoder.replaceImage(for: bytes, keys: [bitmapKey])
  }
}

extension ThumbnailSource {
  /// The thumbnail-cache key of a cloud or PhotoKit photo with no file URL, the
  /// key `ThumbnailLoader` refetches and broadcasts under.
  var refreshKey: String? {
    guard case .thumbnailLoader(let asset, _) = resolvedBackend(), asset.primaryURL == nil
    else { return nil }
    return asset.stableID ?? asset.displayName
  }
}
