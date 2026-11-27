import Foundation

enum GridFilterSidecarStamp: Equatable, Sendable {
  case absent
  case present(modified: Date, size: Int)

  static func stamps(for assets: [AssetRef]) async -> [AssetRef.ID: Self] {
    await Task.detached(priority: .userInitiated) {
      assets.reduce(into: [:]) { stamps, asset in
        guard let url = asset.primaryURL else { return }
        stamps[asset.id] = current(sidecar: SidecarPath.sidecarURL(for: url))
      }
    }.value
  }

  private static func current(sidecar: URL) -> Self? {
    do {
      let attributes = try FileManager.default.attributesOfItem(atPath: sidecar.path)
      guard let modified = attributes[.modificationDate] as? Date,
        let size = attributes[.size] as? NSNumber
      else { return nil }
      return .present(modified: modified, size: size.intValue)
    } catch let error as NSError {
      return error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError
        ? .absent : nil
    }
  }
}

/// Facts read for one listing, each reusable only while its sidecar stamp still matches.
struct GridFilterFactCache {
  struct Entry {
    let stamp: GridFilterSidecarStamp
    let metadata: GridFilterMetadata
  }

  let listingGeneration: UInt64
  let assetIdentityGeneration: UInt64
  let entries: [AssetRef.ID: Entry]

  static let empty = Self(listingGeneration: 0, assetIdentityGeneration: 0, entries: [:])

  func reusable(
    listing: UInt64, identity: UInt64, stamps: [AssetRef.ID: GridFilterSidecarStamp]
  ) -> [AssetRef.ID: GridFilterMetadata] {
    guard listing == listingGeneration, identity == assetIdentityGeneration else { return [:] }
    return entries.reduce(into: [:]) { reused, pair in
      guard let stamp = stamps[pair.key], stamp == pair.value.stamp else { return }
      reused[pair.key] = pair.value.metadata
    }
  }
}
