import Foundation

enum GridFilterSidecarStamp: Equatable, Sendable {
  case absent
  case present(modified: Date, size: Int, fileNumber: UInt64)

  nonisolated static func current(for asset: AssetRef) -> Self? {
    guard let url = asset.primaryURL else { return nil }
    do {
      let attributes = try FileManager.default.attributesOfItem(
        atPath: SidecarPath.sidecarURL(for: url).path)
      guard let modified = attributes[.modificationDate] as? Date,
        let size = attributes[.size] as? NSNumber,
        let fileNumber = attributes[.systemFileNumber] as? NSNumber
      else { return nil }
      return .present(modified: modified, size: size.intValue, fileNumber: fileNumber.uint64Value)
    } catch let error as NSError {
      return error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError
        ? .absent : nil
    }
  }
}

/// Facts read for the current listing, each reusable only while its sidecar stamp still matches.
struct GridFilterFactCache: Sendable {
  struct Entry: Sendable {
    let stamp: GridFilterSidecarStamp
    let metadata: GridFilterMetadata
  }

  struct Loaded: Sendable {
    let id: AssetRef.ID
    let stamp: GridFilterSidecarStamp?
    let metadata: GridFilterMetadata
  }

  let entries: [AssetRef.ID: Entry]

  static let empty = Self(entries: [:])

  init(entries: [AssetRef.ID: Entry]) {
    self.entries = entries
  }

  init(loaded: [Loaded]) {
    self.init(
      entries: loaded.reduce(into: [:]) { entries, item in
        guard let stamp = item.stamp else { return }
        entries[item.id] = Entry(stamp: stamp, metadata: item.metadata)
      })
  }

  func reusableMetadata(for id: AssetRef.ID, stamp: GridFilterSidecarStamp?) -> GridFilterMetadata?
  {
    guard let stamp, let entry = entries[id], entry.stamp == stamp else { return nil }
    return entry.metadata
  }
}
