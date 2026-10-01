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
    return revision == 0 ? id : "\(id):developed:\(revision)"
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
