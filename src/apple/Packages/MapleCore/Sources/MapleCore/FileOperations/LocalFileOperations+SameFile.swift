// LocalFileOperations+SameFile.swift — the same-file / case-only-rename
// guard for the local relocate primitive, split out of
// LocalFileOperations.swift to keep it under the file-size headroom.

import Foundation
import OSLog

private let sameFileLog = Logger(
  subsystem: "app.justmaple.aperture", category: "LocalFileOperations")

extension LocalFileOperations {

  // MARK: - Same-file / case-only-rename guard

  /// Resolve `url`'s PARENT directory through any symlinks
  /// (`resolvingSymlinksInPath()`), then rejoin `url`'s ORIGINAL
  /// (unresolved) last path component literally. Deliberately does NOT
  /// resolve the full path — see `classifySameFile`'s doc comment for
  /// why resolving the basename too would break case-only-rename
  /// detection.
  static func canonicalParent(_ url: URL) -> URL {
    url.deletingLastPathComponent().resolvingSymlinksInPath()
  }

  /// Classifies whether `source` and `target` name the same on-disk
  /// location — directly, or through a symlinked ancestor directory —
  /// versus merely differing in case (a legitimate rename on a
  /// case-insensitive-but-case-preserving filesystem like APFS) versus
  /// genuinely different locations.
  ///
  /// The load-bearing property this protects: a relocate must never
  /// delete the only copy of a file. If the destination resolves to the
  /// source (directly, or via a symlink alias), `copyVerified`'s publish
  /// step would replace the source with a copy OF ITSELF and then, in
  /// move mode, delete "the source" — the only remaining copy — so this
  /// guard refuses that combination outright, before any copy runs at
  /// all.
  ///
  /// Resolving only the PARENT directory (never the basename) is
  /// deliberate: `resolvingSymlinksInPath()` on a case-insensitive
  /// filesystem resolves a query that differs only in case to the file's
  /// STORED casing, so resolving the full path (basename included) would
  /// make `IMG.CR3` and `img.cr3` compare equal whenever either already
  /// exists — collapsing a legitimate case-only rename into "same file"
  /// and wrongly refusing it. Resolving only the directory sidesteps
  /// that: two paths differing solely in basename case still compare
  /// literally unequal, while a symlinked PARENT is still caught (its
  /// target is resolved before the basename is reattached).
  static func classifySameFile(source: URL, target: URL) -> SameFileClassification {
    let sourceParent = canonicalParent(source).standardizedFileURL.path
    let targetParent = canonicalParent(target).standardizedFileURL.path
    guard sourceParent == targetParent else { return .different }

    let sourceBase = source.lastPathComponent
    let targetBase = target.lastPathComponent
    if sourceBase == targetBase { return .identical }
    // On a case-sensitive volume `IMG.CR3` and `img.cr3` are two files (#4707).
    let caseOnly =
      sourceBase.caseInsensitiveCompare(targetBase) == .orderedSame
      && SidecarOwnership.localVolumeFoldsCase(URL(fileURLWithPath: sourceParent))
    return caseOnly ? .caseOnlyRename : .different
  }

  /// The ONE relocate shape that bypasses copy-verify-delete AND
  /// collision handling entirely: on a case-insensitive-but-case-
  /// preserving filesystem, a case-only rename's source and target are
  /// the SAME underlying file. `FileManager.moveItem` (a single atomic
  /// `rename(2)`) is what the OS itself uses to update just the stored
  /// casing — a copy would copy the file onto itself, and
  /// `fileExists`-keyed collision handling would treat the source as
  /// "occupying" its own destination. Does its own cache/index cleanup
  /// inline (there is no separate `finalize` step for an already-atomic
  /// rename — see `RelocatePlan.sourceAlreadyRelocated`). Throws (leaving
  /// the primary untouched) if the rename itself fails, e.g. a permissions
  /// error. Sidecars move first and are rolled back in reverse order on a
  /// failure, so a failed branch cannot quietly orphan the user's edits.
  static func performCaseOnlyRename(source: URL, target: URL) async throws -> RelocatePlan {
    let fm = FileManager.default
    let sourceSidecarURL = SidecarPath.sidecarURL(for: source)
    let hadSidecar = fm.fileExists(atPath: sourceSidecarURL.path)
    let variants = try LocalWorkflowVariants.paired(with: source)
    let variantMoves = try variants.map {
      (source: $0, target: try LocalWorkflowVariants.target(for: $0, from: source, to: target))
    }
    let targetSidecarURL = SidecarPath.sidecarURL(for: target)
    var moved: [(source: URL, target: URL)] = []
    do {
      for pair in variantMoves where pair.source.path != pair.target.path {
        try fm.moveItem(at: pair.source, to: pair.target)
        moved.append(pair)
      }
      if hadSidecar, sourceSidecarURL.path != targetSidecarURL.path {
        try fm.moveItem(at: sourceSidecarURL, to: targetSidecarURL)
        moved.append((sourceSidecarURL, targetSidecarURL))
      }
      try fm.moveItem(at: source, to: target)
    } catch {
      for pair in moved.reversed() {
        do {
          try fm.moveItem(at: pair.target, to: pair.source)
        } catch {
          sameFileLog.error(
            "performCaseOnlyRename: rollback failed (\(pair.target.path, privacy: .public)): \(error.localizedDescription, privacy: .public)"
          )
        }
      }
      throw error
    }

    let plan = RelocatePlan(
      mode: .move, sourcePrimaryPath: source.path,
      sourceSidecarPath: hadSidecar ? sourceSidecarURL.path : nil,
      finalPrimaryPath: target.path,
      finalSidecarPath: hadSidecar ? targetSidecarURL.path : nil,
      renamedDueToCollision: false, createdPaths: [], sourceAlreadyRelocated: true,
      finalVariantPaths: variantMoves.map { $0.target.path })
    await invalidateDerivedCaches(forOldPrimaryPath: source.path)
    // Same index repoint `finalizeRelocate` performs for every other
    // move (#2847): without it the `LibraryIndex` still lists the OLD
    // casing, so the next scan sees the user's own rename as an
    // EXTERNAL one and reconciles it after the fact — self-healing,
    // but wrong the moment reconcile results surface in the UI.
    await refreshLibraryIndexAfterMove(plan)
    return plan
  }
}
