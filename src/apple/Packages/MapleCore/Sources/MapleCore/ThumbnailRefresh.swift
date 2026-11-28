// ThumbnailRefresh.swift — a cloud thumbnail replaced in the background is
// broadcast by its cache key, so every cell showing that photo, now or created
// later, ends up with the new pixels.

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

    func track(_ bitmapKey: String, forAsset assetKey: String) {
      lock.withLock {
        let known = bitmapKeysByAsset.touch(assetKey) ?? []
        bitmapKeysByAsset.set(known.union([bitmapKey]), for: assetKey)
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
    registry.track(bitmapKey, forAsset: assetKey)
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

  /// The refreshed bitmap for a cell: the replaced one, or a decode of the
  /// cached bytes when this cell's bitmap key was not tracked yet.
  public static func refreshedImage(for source: ThumbnailSource, bitmapKey: String) async
    -> CGImage?
  {
    if let cached = ThumbnailDecoder.cachedImage(forKey: bitmapKey) { return cached }
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
