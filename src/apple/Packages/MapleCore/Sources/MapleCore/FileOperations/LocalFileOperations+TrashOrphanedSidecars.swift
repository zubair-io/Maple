// LocalFileOperations+TrashOrphanedSidecars.swift — the orphaned-sidecar pass
// of `sweepExpiredMapleTrash` (#5132).

import Foundation

extension LocalFileOperations {

  /// Removes a `.xmp` under `.maple/trash` that no photo or video in its
  /// folder claims any more and that was last modified more than
  /// `olderThanDays` days ago. The shared-sidecar rule keeps a trashed sidecar
  /// while another same-stem photo is trashed (#4707), so when that photo is
  /// removed by anything but a purge the sidecar outlives it, and nothing else
  /// ever visits it: `listMapleTrash` skips sidecars and the purge iterates
  /// primaries. A sidecar with a photo beside it is never touched.
  static func sweepOrphanedSidecars(libraryRoot: URL, olderThanDays: Int, now: Date) -> Int {
    let trashRoot = libraryRoot.appendingPathComponent(".maple").appendingPathComponent("trash")
    let fm = FileManager.default
    guard
      let enumerator = fm.enumerator(
        at: trashRoot, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]
      )
    else { return 0 }
    let files = enumerator.allObjects.compactMap { $0 as? URL }.filter {
      (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == false
    }
    var removed = 0
    for (folder, siblings) in Dictionary(grouping: files, by: { $0.deletingLastPathComponent() }) {
      let names = siblings.map(\.lastPathComponent)
      let foldsCase = SidecarOwnership.localVolumeFoldsCase(folder)
      for file in siblings where file.pathExtension.lowercased() == "xmp" {
        guard
          SidecarOwnership.isOrphanedSidecar(
            file.lastPathComponent, siblingNames: names, foldsCase: foldsCase),
          isOlderThan(olderThanDays, file: file, now: now),
          (try? fm.removeItem(at: file)) != nil
        else { continue }
        removed += 1
      }
    }
    return removed
  }

  private static func isOlderThan(_ days: Int, file: URL, now: Date) -> Bool {
    guard
      let modified = try? file.resourceValues(forKeys: [.contentModificationDateKey])
        .contentModificationDate
    else { return false }
    return TrashMarker.daysElapsed(since: modified, now: now) > days
  }
}
