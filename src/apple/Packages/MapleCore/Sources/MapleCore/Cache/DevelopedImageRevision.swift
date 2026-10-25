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

  /// Resolve the same decoded key as `decodedKey(for:source:)` after the view
  /// starts its load, with filesystem metadata work on a utility executor.
  public func decodedKeyAsync(for id: String, source: ThumbnailSource) async -> String {
    let base = reloadKey(for: id, source: source)
    guard let url = source.localAssetURL, url.isFileURL else { return base }
    let sourceStamp = await Task.detached(priority: .utility) { () -> String? in
      guard FileManager.default.fileExists(atPath: url.path) else { return nil }
      return LocalDerivativeSourceStamp.signature(for: url)
    }.value
    guard let sourceStamp else { return base }
    return "\(base):source:\(MapleThumbCacheKey.sha256Prefix16(sourceStamp))"
  }

  private func cacheIdentity(for id: String, source: ThumbnailSource) -> String {
    let host: String?
    switch source.resolvedBackend() {
    case .cloudThumb(_, let cloudHost): host = cloudHost
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
