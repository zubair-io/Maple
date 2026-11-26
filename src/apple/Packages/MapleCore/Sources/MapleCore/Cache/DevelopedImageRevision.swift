import Foundation
import Observation

/// Reload retained Browse, filmstrip and Preview images after an editor save
/// completes (#3957). Asset IDs stay stable across edits; decoded pixels don't.
@MainActor
@Observable
public final class DevelopedImageRevision {
  public static let shared = DevelopedImageRevision()
  public static let didChange = Notification.Name("MapleDevelopedImageDidChange")

  private var revisions: [URL: UInt64] = [:]

  public init() {}

  public func revision(for url: URL?) -> UInt64 {
    guard let url else { return 0 }
    return revisions[url, default: 0]
  }

  public func decodedKey(for id: String, url: URL?) -> String {
    let revision = revision(for: url)
    let revisionKey = revision == 0 ? id : "\(id):developed:\(revision)"
    guard let url, url.isFileURL, FileManager.default.fileExists(atPath: url.path) else {
      return revisionKey
    }
    // A synced, replaced, or removed XMP can change pixels without going
    // through `didPersist`. A fresh UI cell must not reuse the old bitmap.
    let sourceStamp = LocalDerivativeSourceStamp.signature(for: url)
    return "\(revisionKey):source:\(MapleThumbCacheKey.sha256Prefix16(sourceStamp))"
  }

  /// Cloud asset IDs name paths within a server, not globally unique images.
  /// Cells, warmers and retained preview seeds must share this same namespace.
  public func decodedKey(for id: String, source: ThumbnailSource) -> String {
    decodedKey(for: cacheIdentity(for: id, source: source), url: source.localAssetURL)
  }

  /// Stable task identity for a view load. Source stamps are deliberately
  /// excluded: reading them while SwiftUI evaluates a grid cell can block the
  /// main thread on a network-backed folder.
  public func reloadKey(for id: String, source: ThumbnailSource) -> String {
    let identity = cacheIdentity(for: id, source: source)
    let revision = revision(for: source.localAssetURL)
    return revision == 0 ? identity : "\(identity):developed:\(revision)"
  }

  static let sourceStampLookupWidth = 16
  static let sourceStampSlots = BoundedAsyncSemaphore(value: sourceStampLookupWidth)

  /// Resolve the same decoded key as `decodedKey(for:source:)` after the view
  /// starts its load, with filesystem metadata work off the main actor. A
  /// visible cell waits on it, so it runs at user-initiated QoS (#6010).
  /// A caller cancelled before its lookup starts gets the stamp-less key.
  /// Preview pages, the phone hero seed and the editor seed pass
  /// `.interactive`, so their lookup is not queued behind a screenful of
  /// grid cells.
  public func decodedKeyAsync(
    for id: String, source: ThumbnailSource,
    priority: BoundedAsyncSemaphore.Priority = .standard
  ) async -> String {
    await decodedKeyAsync(
      for: id, source: source, priority: priority, sourceStamp: Self.localSourceStamp)
  }

  func decodedKeyAsync(
    for id: String, source: ThumbnailSource,
    priority: BoundedAsyncSemaphore.Priority = .standard,
    sourceStamp: @escaping @Sendable (URL) async -> String?
  ) async -> String {
    let base = reloadKey(for: id, source: source)
    guard let url = source.localAssetURL, url.isFileURL else { return base }
    do { try await Self.sourceStampSlots.acquire(priority: priority) } catch { return base }
    guard !Task.isCancelled else {
      await Self.sourceStampSlots.release()
      return base
    }
    // Detached so the file-system lookup can never inherit the main actor.
    let stamp = await Task.detached(priority: .userInitiated) { await sourceStamp(url) }.value
    await Self.sourceStampSlots.release()
    guard let stamp else { return base }
    return "\(base):source:\(MapleThumbCacheKey.sha256Prefix16(stamp))"
  }

  nonisolated static func localSourceStamp(_ url: URL) -> String? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return LocalDerivativeSourceStamp.signature(for: url)
  }

  private func cacheIdentity(for id: String, source: ThumbnailSource) -> String {
    let host: String?
    switch source.resolvedBackend() {
    case .cloudThumb(_, let cloudHost, _): host = cloudHost
    case .thumbnailLoader(let asset, _):
      if let catalog = asset.catalog {
        host = catalog.serverID.cacheHostKey
      } else if case .cloud(let server) = asset.thumbnailProvenance {
        host = server.cacheHostKey
      } else {
        host = nil
      }
    case .photoKit: host = nil
    }
    return host.map { "cloud:\($0.utf8.count):\($0):\(id)" } ?? id
  }

  /// Publish only after both derived-image writes have completed, so a reload
  /// cannot fetch the old display preview over a freshly edited thumbnail.
  public func didPersist(for url: URL) {
    revisions[url, default: 0] &+= 1
    NotificationCenter.default.post(name: Self.didChange, object: url)
  }
}

extension ThumbnailSource {
  public var localAssetURL: URL? {
    guard case .thumbnailLoader(let asset, _) = resolvedBackend() else { return nil }
    return asset.primaryURL
  }
}
