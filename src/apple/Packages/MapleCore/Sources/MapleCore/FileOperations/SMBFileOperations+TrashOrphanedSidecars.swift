// SMBFileOperations+TrashOrphanedSidecars.swift — the orphaned-sidecar pass of
// `sweepExpiredMapleTrash` (#5132); see `LocalFileOperations.sweepOrphanedSidecars`.

import Foundation

extension SMBFileOperations {

  /// The transport reports no per-share case sensitivity, so stems fold case:
  /// the over-inclusive side, a sidecar is removed only once no spelling of
  /// its stem has a photo left. One recursive listing, then an attribute read
  /// for each sidecar nothing claims.
  static func sweepOrphanedSidecars(
    shareRoot: String, olderThanDays: Int, now: Date, transport: SMBFileTransport
  ) async -> Int {
    let trashRoot = posixJoin(normalizedPosixDir(shareRoot), ".maple/trash")
    guard let entries = try? await transport.contentsOfDirectory(atPath: trashRoot, recursive: true)
    else { return 0 }
    let files: [(folder: String, name: String, path: String)] = entries.compactMap { attrs in
      guard (attrs[.isDirectoryKey] as? Bool) != true, let name = attrs[.nameKey] as? String
      else { return nil }
      let path = (attrs[.pathKey] as? String) ?? posixJoin(trashRoot, name)
      return ((path as NSString).deletingLastPathComponent, name, path)
    }
    var removed = 0
    for (_, folder) in Dictionary(grouping: files, by: \.folder) {
      let names = folder.map(\.name)
      for file in folder where file.name.lowercased().hasSuffix(".xmp") {
        guard SidecarOwnership.isOrphanedSidecar(file.name, siblingNames: names),
          let modified = try? await transport.attributesOfItem(atPath: file.path)[
            .contentModificationDateKey] as? Date,
          TrashMarker.daysElapsed(since: modified, now: now) > olderThanDays,
          (try? await transport.removeItem(atPath: file.path)) != nil
        else { continue }
        removed += 1
      }
    }
    return removed
  }
}
