// LocalFileOperations+Trash.swift — Delete → Trash for the local Filesystem
// source (issue #2631).
//
// macOS owns a real Trash the user already knows how to look in, so a
// filesystem-source delete goes straight to `FileManager.trashItem` — one
// syscall for an ordinary photo. Accepted AI removals instead travel as one
// verified recovery folder so Finder cannot separate RAW/XMP/companions (#3944). iOS/iPadOS has no OS trash for a
// security-scoped folder, so it falls back to `.maple/trash/<rel>` under the
// library root via the SAME relocate primitive every other move here uses.

import Foundation

extension LocalFileOperations {

  /// Trash a single asset (primary + sidecar).
  public static func trash(_ primaryURL: URL, libraryRoot: URL) async throws -> RelocateOutcome {
    #if os(macOS)
      return try await trashToOSTrash(primaryURL)
    #else
      return try await trashToMapleFolder(primaryURL, libraryRoot: libraryRoot)
    #endif
  }

  #if os(macOS)
    /// The real OS Trash. No `#if`-independent counterpart to test against —
    /// `FileManager.trashItem` is Apple's own contract to keep, not logic
    /// this module owns.
    static func trashToOSTrash(_ primaryURL: URL) async throws -> RelocateOutcome {
      let fm = FileManager.default
      let source = try LocalRemovalRelocation.open(rawURL: primaryURL)
      if let records = source.records, !(try RemovalBridge.assetNames(records: records)).isEmpty {
        return try await trashAcceptedRemoval(source, raw: primaryURL)
      }
      var trashedPrimary: NSURL?
      try fm.trashItem(at: primaryURL, resultingItemURL: &trashedPrimary)

      let sidecarURL = SidecarPath.sidecarURL(for: primaryURL)
      var trashedSidecarURL: URL?
      if fm.fileExists(atPath: sidecarURL.path) {
        var resultingURL: NSURL?
        try? fm.trashItem(at: sidecarURL, resultingItemURL: &resultingURL)
        trashedSidecarURL = resultingURL as URL?
      }
      await invalidateDerivedCaches(forOldPrimaryPath: primaryURL.path)
      return RelocateOutcome(
        primaryPath: (trashedPrimary as URL?)?.path ?? primaryURL.path,
        sidecarPath: trashedSidecarURL?.path,
        renamedDueToCollision: false,
        sidecarFollowed: trashedSidecarURL != nil
      )
    }
  #endif

  /// `.maple/trash/<rel>` fallback. iOS/iPadOS routes here always; it has
  /// no `#if os` gate so it's also directly reachable (and testable) on
  /// macOS, where `trash(_:libraryRoot:)` itself never calls it.
  static func trashToMapleFolder(_ primaryURL: URL, libraryRoot: URL) async throws
    -> RelocateOutcome
  {
    let trashDir = try trashDestinationDir(for: primaryURL, libraryRoot: libraryRoot)
    let outcome = try await relocate(primaryURL, to: trashDir, mode: .move, collision: .autoSuffix)
    let trashed = URL(fileURLWithPath: outcome.primaryPath)
    removeTrashedMarker(forItemAt: trashed)
    writeTrashedMarker(forItemAt: trashed)
    return outcome
  }

  /// `<libraryRoot>/.maple/trash/<relative-parent-directory>` — mirrors
  /// the API's `computeTrashPath` (`src/api/src/fs/trash.ts`), which
  /// preserves the item's relative position under the root so Restore can
  /// reconstruct the original tree. Works for both a file and a folder:
  /// it only cares about `item`'s PARENT directory, so folder-delete
  /// reuses it verbatim to compute where the folder itself should land.
  static func trashDestinationDir(for item: URL, libraryRoot: URL) throws -> URL {
    let rootPath = libraryRoot.standardizedFileURL.path
    let parentPath = item.deletingLastPathComponent().standardizedFileURL.path
    guard parentPath == rootPath || parentPath.hasPrefix(rootPath + "/") else {
      throw FileOperationError.invalidDestination(
        "\(item.path) is not under library root \(libraryRoot.path)")
    }
    let trashRoot = libraryRoot.appendingPathComponent(".maple").appendingPathComponent("trash")
    guard parentPath != rootPath else { return trashRoot }
    let relSuffix = String(parentPath.dropFirst(rootPath.count + 1))
    return trashRoot.appendingPathComponent(relSuffix)
  }

  // MARK: - Restore / list / purge (`.maple/trash` only — see file header)

  /// Restore a `.maple/trash`-backed item to its original location — the
  /// mirror image of `trashDestinationDir` — auto-suffixing on a
  /// collision using the shared `.restored[.N]` namespace.
  public static func restoreFromMapleTrash(_ trashedPrimaryURL: URL, libraryRoot: URL) async throws
    -> RelocateOutcome
  {
    let originalDir = try originalDestinationDir(for: trashedPrimaryURL, libraryRoot: libraryRoot)
    let realRoot = libraryRoot.resolvingSymlinksInPath().standardizedFileURL
    let rootPath = realRoot.path
    let realTrash =
      realRoot.appendingPathComponent(".maple").appendingPathComponent("trash").path + "/"
    guard trashedPrimaryURL.resolvingSymlinksInPath().standardizedFileURL.path.hasPrefix(realTrash)
    else {
      throw FileOperationError.invalidDestination(trashedPrimaryURL.path)
    }
    let realDestination = originalDir.resolvingSymlinksInPath().standardizedFileURL.path
    let rootPrefix = rootPath == "/" ? "/" : rootPath + "/"
    guard realDestination == rootPath || realDestination.hasPrefix(rootPrefix) else {
      throw FileOperationError.invalidDestination(originalDir.path)
    }
    let job = Task.detached(priority: .userInitiated) {
      try restoreFilePair(trashedPrimaryURL, to: originalDir, confinedTo: libraryRoot)
    }
    let plan = try await withTaskCancellationHandler {
      try await job.value
    } onCancel: {
      job.cancel()
    }
    await invalidateDerivedCaches(forOldPrimaryPath: plan.sourcePrimaryPath)
    await refreshLibraryIndexAfterMove(plan)
    removeTrashedMarker(forItemAt: trashedPrimaryURL)
    return RelocateOutcome(
      primaryPath: plan.finalPrimaryPath, sidecarPath: plan.finalSidecarPath,
      renamedDueToCollision: plan.renamedDueToCollision,
      sidecarFollowed: plan.finalSidecarPath != nil)
  }

  /// Inverse of `trashDestinationDir`: given an item's CURRENT location
  /// inside `<libraryRoot>/.maple/trash/<relSuffix>`, returns
  /// `<libraryRoot>/<relSuffix>` — where Restore should put it back.
  static func originalDestinationDir(for trashedItem: URL, libraryRoot: URL) throws -> URL {
    let trashRoot = libraryRoot.appendingPathComponent(".maple").appendingPathComponent("trash")
      .standardizedFileURL.path
    let parentPath = trashedItem.deletingLastPathComponent().standardizedFileURL.path
    guard parentPath == trashRoot || parentPath.hasPrefix(trashRoot + "/") else {
      throw FileOperationError.invalidDestination(
        "\(trashedItem.path) is not inside .maple/trash under \(libraryRoot.path)")
    }
    guard parentPath != trashRoot else { return libraryRoot }
    let relSuffix = String(parentPath.dropFirst(trashRoot.count + 1))
    return libraryRoot.appendingPathComponent(relSuffix)
  }

  /// Every item currently sitting in `<libraryRoot>/.maple/trash`, newest
  /// first. Skips `.xmp` sidecars (folded into their primary's
  /// `TrashedItem.sidecarPath`) and marker directories (folded into
  /// `trashedDate`). Windows original-path metadata is also hidden (#4009).
  /// Every restorable item; an item an SMB copy-only restore marked
  /// `.restored-` on the same share is hidden (#4139).
  public static func listMapleTrash(libraryRoot: URL) -> [TrashedItem] {
    listMapleTrashEntries(libraryRoot: libraryRoot).filter { $0.restoredDate == nil }.map(\.item)
  }

  static func listMapleTrashEntries(libraryRoot: URL) -> [(item: TrashedItem, restoredDate: Date?)]
  {
    let trashRoot = libraryRoot.appendingPathComponent(".maple").appendingPathComponent("trash")
    // Standardized once, for the pathComponents-based `rel` computation
    // below — a raw string-length drop against `trashRoot.path` breaks
    // whenever the enumerator hands back symlink-resolved URLs (e.g.
    // macOS's temp dir under `/tmp` resolving to `/private/tmp`), which
    // shifts the actual prefix length out from under a fixed-count drop.
    let trashRootComponentCount = trashRoot.standardizedFileURL.pathComponents.count
    let fm = FileManager.default
    guard
      let enumerator = fm.enumerator(
        at: trashRoot, includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles]
      )
    else { return [] }
    var items: [(item: TrashedItem, restoredDate: Date?)] = []
    for case let url as URL in enumerator {
      guard let isDir = try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory,
        isDir == false
      else { continue }
      guard url.pathExtension.lowercased() != "xmp" else { continue }
      guard
        !url.lastPathComponent.lowercased().hasSuffix(FilenameVocabulary.originalPathMarkerSuffix)
      else { continue }
      guard !TrashMarker.isAnyMarker(url.lastPathComponent) else { continue }
      let sidecarURL = SidecarPath.sidecarURL(for: url)
      let rel = url.standardizedFileURL.pathComponents.dropFirst(trashRootComponentCount).joined(
        separator: "/")
      let size =
        ((try? fm.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? 0
      items.append(
        (
          TrashedItem(
            id: url.path, primaryPath: url.path,
            sidecarPath: fm.fileExists(atPath: sidecarURL.path) ? sidecarURL.path : nil,
            originalRelativePath: rel,
            trashedDate: trashedDate(forItemAt: url),
            size: size
          ),
          trashedDate(forItemAt: url, kind: .restored)
        ))
    }
    return items.sorted {
      ($0.item.trashedDate ?? .distantPast) > ($1.item.trashedDate ?? .distantPast)
    }
  }

  /// Permanently unlinks a trashed item — primary, sidecar, and its
  /// marker — with no further recovery. Best-effort on the sidecar/marker
  /// (matches every other cleanup path in this module); the primary
  /// unlink is the one call that throws.
  ///
  /// `libraryRoot` is REQUIRED and hard-guarded (review finding — every
  /// other trash primitive in this file routes through
  /// `trashDestinationDir`/`originalDestinationDir`, which refuse a path
  /// outside `.maple/trash`; this is the one IRREVERSIBLE primitive in
  /// the module, and it must not rely on a caller passing a `TrashedItem`
  /// it trusts blindly — CLAUDE.md's "never write code that could delete
  /// user photos" applies squarely here).
  public static func permanentlyDeleteFromMapleTrash(_ item: TrashedItem, libraryRoot: URL) throws {
    try requireUnderMapleTrash(item.primaryPath, libraryRoot: libraryRoot)
    let fm = FileManager.default
    try fm.removeItem(atPath: item.primaryPath)
    if let sidecarPath = item.sidecarPath {
      try? fm.removeItem(atPath: sidecarPath)
    }
    removeTrashedMarker(forItemAt: URL(fileURLWithPath: item.primaryPath))
  }

  /// Throws `.invalidDestination` unless `path` resolves to somewhere
  /// strictly inside `<libraryRoot>/.maple/trash` — the one check every
  /// reversible sibling in this file already gets for free from
  /// `trashDestinationDir`/`originalDestinationDir`, made explicit here
  /// for the irreversible primitive that has no such helper of its own.
  static func requireUnderMapleTrash(_ path: String, libraryRoot: URL) throws {
    let trashRoot = libraryRoot.appendingPathComponent(".maple").appendingPathComponent("trash")
      .standardizedFileURL.path
    let candidate = URL(fileURLWithPath: path).standardizedFileURL.path
    guard candidate.hasPrefix(trashRoot + "/") else {
      throw FileOperationError.invalidDestination(
        "\(path) is not inside .maple/trash under \(libraryRoot.path) — refusing permanent delete")
    }
  }

  /// Permanently deletes every item in `<libraryRoot>/.maple/trash` whose
  /// marker says it's MORE than `olderThanDays` full calendar days old
  /// (design doc: "30-day auto-purge applies to the Maple-private trash
  /// only" — `TrashMarker.daysElapsed`'s doc comment covers why this is a
  /// day-to-day comparison, not a raw 24h-multiple, and why it's strictly
  /// `>`, not `>=`). Items with NO marker (trashed before this scheme
  /// existed, or a marker write that failed) are left alone rather than
  /// guessed at — the same conservatism as the PhotoKit orphan sweeper
  /// only ever acting on dated entries. Also removes any ORPHANED marker
  /// (`sweepOrphanedMarkers`) whose primary is already gone. Returns the
  /// total count of primaries purged plus orphaned markers removed.
  @discardableResult
  public static func sweepExpiredMapleTrash(
    libraryRoot: URL, olderThanDays: Int = 30, now: Date = Date()
  ) -> Int {
    var purged = 0
    for entry in listMapleTrashEntries(libraryRoot: libraryRoot) {
      guard let agedFrom = entry.item.trashedDate ?? entry.restoredDate,
        TrashMarker.daysElapsed(since: agedFrom, now: now) > olderThanDays
      else { continue }
      if (try? permanentlyDeleteFromMapleTrash(entry.item, libraryRoot: libraryRoot)) != nil {
        purged += 1
      }
    }
    purged += sweepOrphanedMarkers(libraryRoot: libraryRoot)
    return purged
  }

  /// Removes a trashed-date marker whose primary no longer exists — e.g.
  /// the primary was permanently deleted, or removed externally. Without
  /// this, an orphaned marker directory sits invisibly forever: both
  /// `listMapleTrash` (which explicitly skips marker names while
  /// enumerating primaries) and the age-based purge loop above (which
  /// only ever iterates primaries) have no other path back to it. Folded
  /// into `sweepExpiredMapleTrash` since both run on the same once-daily
  /// cadence rather than needing a separate scheduled call.
  static func sweepOrphanedMarkers(libraryRoot: URL) -> Int {
    let trashRoot = libraryRoot.appendingPathComponent(".maple").appendingPathComponent("trash")
    let fm = FileManager.default
    guard
      let enumerator = fm.enumerator(
        at: trashRoot, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]
      )
    else { return 0 }
    var removed = 0
    for case let url as URL in enumerator {
      guard let isDir = try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory,
        isDir == true
      else { continue }
      guard let parsed = TrashMarker.parseMarkerDirName(url.lastPathComponent) else { continue }
      let primaryURL = url.deletingLastPathComponent().appendingPathComponent(parsed.basename)
      guard !fm.fileExists(atPath: primaryURL.path) else { continue }
      try? fm.removeItem(at: url)
      removed += 1
    }
    return removed
  }

  // MARK: - Trashed-date marker (see TrashMarker.swift)

  static func writeTrashedMarker(forItemAt primaryURL: URL, date: Date = Date()) {
    let markerURL = primaryURL.deletingLastPathComponent().appendingPathComponent(
      TrashMarker.markerName(forItemBasename: primaryURL.lastPathComponent, date: date))
    try? FileManager.default.createDirectory(at: markerURL, withIntermediateDirectories: true)
  }

  /// Writes a `TrashMarker` beside every non-`.xmp` primary found
  /// (recursively) under `folderURL` — issue #2945: a folder-level trash
  /// (`trashFolderToMapleFolder`) is a single directory move with no
  /// per-item relocate call, so nothing else in that path ever calls
  /// `writeTrashedMarker`. One marker PER CONTAINED PHOTO — not one for
  /// the folder root — is the deliberate choice here: `listMapleTrash`
  /// and `sweepExpiredMapleTrash`/`sweepOrphanedMarkers` already walk the
  /// trash tree file-by-file (never folder-by-folder, see their own doc
  /// comments), so a per-photo marker is exactly what that existing code
  /// already knows how to find, purge, and clean up on restore — zero
  /// special-casing for "this primary's trashed date lives on some
  /// ancestor directory instead of beside it." A single folder-root
  /// marker would need all three of those to learn that new concept.
  static func writeTrashedMarkers(forSubtreeAt folderURL: URL, date: Date = Date()) {
    let fm = FileManager.default
    guard
      let enumerator = fm.enumerator(
        at: folderURL, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]
      )
    else { return }
    for case let url as URL in enumerator {
      guard let isDir = try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory,
        isDir == false
      else { continue }
      guard url.pathExtension.lowercased() != "xmp" else { continue }
      writeTrashedMarker(forItemAt: url, date: date)
    }
  }

  static func removeTrashedMarker(forItemAt primaryURL: URL) {
    let dir = primaryURL.deletingLastPathComponent()
    guard let contents = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else {
      return
    }
    let basename = primaryURL.lastPathComponent
    for name in contents where TrashMarker.isMarker(name, forItemBasename: basename) {
      try? FileManager.default.removeItem(atPath: dir.appendingPathComponent(name).path)
    }
  }

  static func trashedDate(forItemAt primaryURL: URL, kind: TrashMarker.Kind = .trashed) -> Date? {
    let dir = primaryURL.deletingLastPathComponent()
    guard let contents = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else {
      return nil
    }
    let basename = primaryURL.lastPathComponent
    for name in contents {
      if let date = TrashMarker.date(fromMarkerName: name, itemBasename: basename, kind: kind) {
        return date
      }
    }
    return nil
  }
}
