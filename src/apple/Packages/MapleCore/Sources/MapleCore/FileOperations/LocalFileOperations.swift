// LocalFileOperations.swift — relocate primitive for the local Filesystem
// source (issue #2631). Copy → verify → sidecar-follow → delete, split into
// `planRelocate` (copy + verify, no deletes) and `finalizeRelocate` (delete
// + cache/index cleanup) so the crash-safety invariant is directly
// testable: call `planRelocate` alone and both the source and the staged
// copy exist on disk, which is exactly the state a real crash between the
// two phases would leave behind. See docs/superpowers/specs/
// 2026-08-04-file-management-design.md § "Core architecture".
//
// Stateless by design (a namespace of static functions, like `SidecarPath`)
// — there is no per-instance state to protect, so this isn't wrapped in an
// actor the way stateful I/O owners (`XMPSidecarStore`, `ThumbnailLoader`)
// are.

import Foundation
import OSLog

private let fileOpsLog = Logger(
  subsystem: "app.justmaple.aperture", category: "LocalFileOperations")

public enum LocalFileOperations {

  /// Tolerance for the post-copy mtime check — `setAttributes` round-trips
  /// through the filesystem's own clock precision, so exact `Date`
  /// equality is not guaranteed even for a byte-perfect copy.
  static let mtimeTolerance: TimeInterval = 2.0

  // MARK: - Relocate (asset-level: primary + sidecar)

  /// Convenience: plan then finalize in one call. Most callers want this;
  /// `planRelocate`/`finalizeRelocate` exist separately for crash-safety
  /// testing (see the file header) and so a caller can inspect a plan
  /// before committing to it.
  public static func relocate(
    _ sourcePrimaryURL: URL,
    to destinationDir: URL,
    newBasename: String? = nil,
    mode: RelocateMode,
    collision: CollisionPolicy = .autoSuffix
  ) async throws -> RelocateOutcome {
    let plan = try await planRelocate(
      sourcePrimaryURL, to: destinationDir,
      newBasename: newBasename, mode: mode, collision: collision)
    return await finalizeRelocate(plan)
  }

  /// Copy (never move) the primary file and its canonical/UUID workflow
  /// `.xmp` sidecars into `destinationDir`, verifying each copy. Nothing is
  /// deleted and the source is untouched no matter how this call ends,
  /// including when it throws. The one exception is a case-only rename
  /// (see `classifySameFile`), which is performed directly here as an
  /// atomic move — there is no meaningful "staged copy" for it.
  ///
  /// `async` even though every step is a synchronous local `FileManager`
  /// call — matches `ImageSource`'s shape (`FilesystemSource.rawBytes` is
  /// `async throws` too) and lets this share `CollisionResolver`'s async
  /// algorithm with the real-network SMB engine verbatim.
  public static func planRelocate(
    _ sourcePrimaryURL: URL,
    to destinationDir: URL,
    newBasename: String? = nil,
    mode: RelocateMode,
    collision: CollisionPolicy = .autoSuffix
  ) async throws -> RelocatePlan {
    let fm = FileManager.default
    guard fm.fileExists(atPath: sourcePrimaryURL.path) else {
      throw FileOperationError.sourceMissing(sourcePrimaryURL.path)
    }
    // A caller-supplied basename is exactly the "manually-typed name"
    // hazard `FilenameValidation` exists to guard: `appendingPathComponent`
    // below SPLITS on an embedded `/`, so an unvalidated `newBasename`
    // like `../../Desktop/oops` (or a bare `..`) escapes `destinationDir`
    // entirely — the same traversal `LocalFileOperations+Folders.swift`'s
    // New Folder/Rename already guards (#2645 review). This call site was
    // missing the same guard (found by the #2633 cross-platform parity
    // harness — the C# port added it, this one hadn't).
    if let newBasename, !FilenameValidation.isValidPathComponent(newBasename) {
      throw FileOperationError.invalidName(newBasename)
    }

    let basename = newBasename ?? sourcePrimaryURL.lastPathComponent
    let targetURL = destinationDir.appendingPathComponent(basename)

    switch classifySameFile(source: sourcePrimaryURL, target: targetURL) {
    case .identical:
      throw FileOperationError.sameFile(
        "destination resolves to the same file as the source: \(sourcePrimaryURL.path)")
    case .caseOnlyRename:
      guard mode == .move else {
        throw FileOperationError.sameFile(
          "case-only rename target is the same file as the source on a case-insensitive "
            + "filesystem — copy is not meaningful: \(sourcePrimaryURL.path)")
      }
      return try await performCaseOnlyRename(source: sourcePrimaryURL, target: targetURL)
    case .different:
      break
    }

    try fm.createDirectory(at: destinationDir, withIntermediateDirectories: true)
    let sourceSidecarURL = SidecarPath.sidecarURL(for: sourcePrimaryURL)
    let hasSourceSidecar = fm.fileExists(atPath: sourceSidecarURL.path)
    let sourceVariants = try LocalWorkflowVariants.paired(with: sourcePrimaryURL)
    let (resolvedTargetURL, renamed) = try await resolveCollision(
      at: targetURL, collision: collision, ownSidecar: hasSourceSidecar ? sourceSidecarURL : nil,
      sourcePrimaryURL: sourcePrimaryURL)
    let sidecarTargetURL = SidecarPath.sidecarURL(for: resolvedTargetURL)

    // The shared-sidecar ownership rule (#4707, docs/xmp-canonical-format.md
    // § "Moving, renaming and trashing a photo"), decided before any byte moves.
    let sidecarMapsOntoItself = SidecarOwnership.sameLocalFile(
      sourceSidecarURL.path, sidecarTargetURL.path)
    let destinationSidecarOccupied =
      !sidecarMapsOntoItself && fm.fileExists(atPath: sidecarTargetURL.path)
    let joinsCarriedSidecar =
      hasSourceSidecar && destinationSidecarOccupied
      && SidecarOwnership.localSidecarAlreadyCarried(
        sourceSidecarURL.path, at: sidecarTargetURL.path)
    let destinationClaimed = SidecarOwnership.localStemClaimedBySibling(
      resolvedTargetURL, excluding: [sourcePrimaryURL])
    if hasSourceSidecar, destinationSidecarOccupied, !joinsCarriedSidecar,
      collision != .replace || destinationClaimed
    {
      throw FileOperationError.destinationExists(sidecarTargetURL.path)
    }
    // Replace must not silently attach an old occupant's UUID branches to
    // this photo. Other policies have already resolved these collisions to
    // a free stem above; recheck before any byte copies for a racing writer.
    if try LocalWorkflowVariants.occupied(at: resolvedTargetURL, excluding: sourcePrimaryURL) {
      throw FileOperationError.destinationExists(resolvedTargetURL.path)
    }
    let sourceClaimed = SidecarOwnership.localStemClaimedBySibling(
      sourcePrimaryURL, excluding: [resolvedTargetURL])
    let copiesSidecar = hasSourceSidecar && !sidecarMapsOntoItself && !joinsCarriedSidecar
    let variantPairs = try sourceVariants.map { variant in
      (
        source: variant,
        destination: try LocalWorkflowVariants.target(
          for: variant, from: sourcePrimaryURL, to: resolvedTargetURL)
      )
    }.filter { !SidecarOwnership.sameLocalFile($0.source.path, $0.destination.path) }
    let variantCopies = variantPairs.filter {
      !SidecarOwnership.localSidecarAlreadyCarried($0.source.path, at: $0.destination.path)
    }

    let primaryTmp = try stageVerifiedCopy(
      from: sourcePrimaryURL, forDestination: resolvedTargetURL)
    let sidecarTmp: URL?
    do {
      sidecarTmp =
        copiesSidecar
        ? try stageVerifiedCopy(from: sourceSidecarURL, forDestination: sidecarTargetURL)
        : nil
    } catch {
      try? fm.removeItem(at: primaryTmp)
      throw error
    }

    var variantTemps: [(source: URL, destination: URL, temp: URL)] = []
    do {
      for pair in variantCopies {
        let type = try fm.attributesOfItem(atPath: pair.source.path)[.type] as? FileAttributeType
        guard type == .typeRegular else {
          throw FileOperationError.underlying(
            "workflow branch is not a regular file: \(pair.source.path)")
        }
        let temp = try stageVerifiedCopy(from: pair.source, forDestination: pair.destination)
        variantTemps.append((pair.source, pair.destination, temp))
      }
    } catch {
      try? fm.removeItem(at: primaryTmp)
      if let sidecarTmp { try? fm.removeItem(at: sidecarTmp) }
      for item in variantTemps { try? fm.removeItem(at: item.temp) }
      throw error
    }

    // Publish branches under exclusive names before the primary pair. If a
    // later publication fails, all source files still exist and the new
    // branches are withdrawn. Never replace an unrelated UUID branch.
    var publishedVariants: [URL] = []
    do {
      for item in variantTemps {
        try fm.moveItem(at: item.temp, to: item.destination)
        publishedVariants.append(item.destination)
      }

      // Publish the verified temp(s) as an atomic pair: any existing
      // occupant primary is backed up without unpublishing it first and
      // atomically restored if publishing or clearing the sidecar fails (#4704).
      try publishStagedPair(
        primaryTmp: primaryTmp,
        primaryDestination: resolvedTargetURL,
        sidecarTmp: sidecarTmp,
        sidecarDestination: sidecarTargetURL,
        clearStaleSidecar: !hasSourceSidecar && collision == .replace && !destinationClaimed,
        sourcePrimaryURL: sourcePrimaryURL
      )
    } catch {
      try? fm.removeItem(at: primaryTmp)
      if let sidecarTmp { try? fm.removeItem(at: sidecarTmp) }
      for item in variantTemps { try? fm.removeItem(at: item.temp) }
      for variant in publishedVariants { try? fm.removeItem(at: variant) }
      throw error
    }

    return RelocatePlan(
      mode: mode, sourcePrimaryPath: sourcePrimaryURL.path,
      sourceSidecarPath: hasSourceSidecar ? sourceSidecarURL.path : nil,
      finalPrimaryPath: resolvedTargetURL.path,
      finalSidecarPath: hasSourceSidecar ? sidecarTargetURL.path : nil,
      renamedDueToCollision: renamed,
      createdPaths: [resolvedTargetURL.path] + (copiesSidecar ? [sidecarTargetURL.path] : [])
        + publishedVariants.map(\.path),
      retainsSourceSidecar: sidecarMapsOntoItself || sourceClaimed,
      sourceVariantPaths: variantPairs.map { $0.source.path },
      finalVariantPaths: variantPairs.map { $0.destination.path })
  }

  /// Delete the sources (`mode == .move` only), invalidate the derived
  /// thumb/preview caches at the OLD location, and best-effort refresh
  /// the `LibraryIndex` entries. Every step here is best-effort: per the
  /// design doc, "a copy-succeeded-but-delete-failed leaves a duplicate,
  /// never data loss" — a failure is logged (`fileOpsLog`), never thrown,
  /// since the plan already committed a verified, correct copy at the
  /// destination. A no-op for a case-only rename (`isNoop`): that already
  /// did everything inside `planRelocate`, and re-touching
  /// `sourcePrimaryPath` here would delete the file that was just renamed
  /// (on a case-insensitive filesystem the old-cased path still resolves
  /// to it).
  @discardableResult
  public static func finalizeRelocate(_ plan: RelocatePlan) async -> RelocateOutcome {
    let outcome = RelocateOutcome(
      primaryPath: plan.finalPrimaryPath, sidecarPath: plan.finalSidecarPath,
      renamedDueToCollision: plan.renamedDueToCollision,
      sidecarFollowed: plan.finalSidecarPath != nil || !plan.finalVariantPaths.isEmpty
    )
    guard !plan.isNoop else { return outcome }
    carryFreshDerivatives(for: plan)
    guard plan.mode == .move else { return outcome }

    let fm = FileManager.default
    do {
      try fm.removeItem(atPath: plan.sourcePrimaryPath)
    } catch {
      fileOpsLog.error(
        "finalizeRelocate: source primary unlink failed after a verified copy — a duplicate is left on disk (\(plan.sourcePrimaryPath, privacy: .public)): \(error.localizedDescription, privacy: .public)"
      )
    }
    if let sourceSidecarPath = plan.sourceSidecarPath, !plan.retainsSourceSidecar {
      do {
        try fm.removeItem(atPath: sourceSidecarPath)
      } catch {
        fileOpsLog.error(
          "finalizeRelocate: source sidecar unlink failed after a verified copy (\(sourceSidecarPath, privacy: .public)): \(error.localizedDescription, privacy: .public)"
        )
      }
    }
    if !plan.retainsSourceSidecar {
      for sourceVariantPath in plan.sourceVariantPaths {
        do {
          try fm.removeItem(atPath: sourceVariantPath)
        } catch {
          fileOpsLog.error(
            "finalizeRelocate: source workflow branch unlink failed after a verified copy (\(sourceVariantPath, privacy: .public)): \(error.localizedDescription, privacy: .public)"
          )
        }
      }
    }
    await invalidateDerivedCaches(forOldPrimaryPath: plan.sourcePrimaryPath)
    await refreshLibraryIndexAfterMove(plan)
    return outcome
  }

  /// Undo a plan that will never be finalized — removes the staged
  /// copies, leaving the source (and everything else) exactly as it was
  /// before `planRelocate` ran. Not applicable to a case-only rename
  /// (`sourceAlreadyRelocated`) — that has no staged copies to revert;
  /// undoing it would mean renaming back, which a caller that actually
  /// needs that can do by calling `planRelocate` again in reverse.
  public static func revertPlan(_ plan: RelocatePlan) {
    for path in plan.createdPaths {
      try? FileManager.default.removeItem(atPath: path)
    }
  }

  // MARK: - Copy + verify

  /// `.tmp.` must appear in the basename — matches `fs/relocate.ts`'s
  /// `tempPathFor` convention (any future replication watcher can
  /// recognise, and skip mirroring, this temp-then-publish idiom).
  private static func tempURL(for destination: URL) -> URL {
    URL(
      fileURLWithPath: destination.path
        + ".tmp.\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString.prefix(8))")
  }

  /// Publish a verified temp copy to its final destination. When nothing
  /// occupies `destination` this is a plain atomic `moveItem`. When
  /// something DOES occupy it (a `.replace` collision, or a stray sidecar
  /// sharing the derived name), `FileManager.replaceItemAt` is used
  /// instead — Foundation's purpose-built atomic swap, which backs up the
  /// existing item and restores it if the swap itself fails, rather than
  /// this module removing the occupant by hand before the copy is even
  /// known to succeed.
  private static func publish(_ tmp: URL, to destination: URL) throws {
    let fm = FileManager.default
    if fm.fileExists(atPath: destination.path) {
      _ = try fm.replaceItemAt(destination, withItemAt: tmp)
    } else {
      try fm.moveItem(at: tmp, to: destination)
    }
  }

  /// Copy `source` to `destination` via a verified temp-then-publish
  /// sequence: copy to a temp sibling of `destination`, preserve
  /// `source`'s modification date (a pure rename/move must not invalidate
  /// the mtime-keyed rendered-preview cache — docs/caching.md § 3),
  /// verify, then atomically publish (see `publish` above).
  ///
  /// This is the crash-safety correction the TS (`fs/relocate.ts`
  /// `copyVerifiedIntoPlace`) and Windows (`LocalFileOperations.
  /// CopyVerify.cs`) twins already made: copying straight to `destination`
  /// — this module's prior shape — meant a hard failure mid-copy could
  /// leave a truncated file sitting at the real destination name, and
  /// (worse, for `.replace`) `resolveCollision` used to delete the
  /// existing occupant BEFORE this ran at all, so a subsequent copy
  /// failure left NEITHER the old file nor a new one on disk — exactly
  /// the "replace-mode ordering" bug class the #2633 cross-platform
  /// parity harness's corpus targets. Publishing via a verified temp file
  /// means `destination` either keeps its prior occupant untouched, or
  /// ends up with the fully-verified new file — never a partial write,
  /// and never a deleted-then-never-replaced gap.
  ///
  /// On any failure the temp file is removed and the error propagates;
  /// neither `source` nor any prior occupant of `destination` is ever
  /// touched.
  private static func stageVerifiedCopy(from source: URL, forDestination destination: URL) throws
    -> URL
  {
    let fm = FileManager.default
    let sourceAttrs = try fm.attributesOfItem(atPath: source.path)
    guard let sourceSize = (sourceAttrs[.size] as? NSNumber)?.int64Value else {
      throw FileOperationError.underlying("could not read size of \(source.path)")
    }
    let sourceMtime = sourceAttrs[.modificationDate] as? Date
    let tmp = tempURL(for: destination)

    do {
      try fm.copyItem(at: source, to: tmp)
      if let sourceMtime {
        try? fm.setAttributes([.modificationDate: sourceMtime], ofItemAtPath: tmp.path)
      }
      try verifyCopy(sourceSize: sourceSize, sourceMtime: sourceMtime, destinationURL: tmp)
      return tmp
    } catch {
      try? fm.removeItem(at: tmp)
      throw (error as? FileOperationError)
        ?? .underlying(
          "copy \(source.path) -> \(destination.path) failed: \(error.localizedDescription)")
    }
  }

  static func publishStagedPair(
    primaryTmp: URL,
    primaryDestination: URL,
    sidecarTmp: URL?,
    sidecarDestination: URL,
    clearStaleSidecar: Bool,
    sourcePrimaryURL: URL
  ) throws {
    let fm = FileManager.default
    let hasStaleSidecar = clearStaleSidecar && fm.fileExists(atPath: sidecarDestination.path)
    let hasSidecarWork = sidecarTmp != nil || hasStaleSidecar
    var primaryBackup: URL?
    var primaryPublished = false

    do {
      if hasSidecarWork, fm.fileExists(atPath: primaryDestination.path) {
        let backup = try stageVerifiedCopy(
          from: primaryDestination, forDestination: primaryDestination)
        try? fm.setAttributes([.immutable: false], ofItemAtPath: backup.path)
        primaryBackup = backup
      }
      try publish(primaryTmp, to: primaryDestination)
      primaryPublished = true

      if hasSidecarWork, fm.fileExists(atPath: sidecarDestination.path) {
        var isDirectory: ObjCBool = false
        fm.fileExists(atPath: sidecarDestination.path, isDirectory: &isDirectory)
        guard !isDirectory.boolValue else {
          throw FileOperationError.invalidDestination(
            "cannot replace a folder with a sidecar: \(sidecarDestination.path)")
        }
      }
      if let sidecarTmp {
        try publish(sidecarTmp, to: sidecarDestination)
      } else if hasStaleSidecar {
        try fm.removeItem(at: sidecarDestination)
      }
    } catch {
      try? fm.removeItem(at: primaryTmp)
      if let sidecarTmp { try? fm.removeItem(at: sidecarTmp) }
      if primaryPublished {
        if let primaryBackup {
          do {
            try restoreBackup(from: primaryBackup, to: primaryDestination)
            try? fm.removeItem(at: primaryBackup)
          } catch {
            fileOpsLog.error(
              "publishStagedPair: failed to restore backup \(primaryBackup.path, privacy: .public) to \(primaryDestination.path, privacy: .public); retaining backup: \(error.localizedDescription, privacy: .public)"
            )
          }
        } else {
          try? fm.removeItem(at: primaryDestination)
        }
      } else if let primaryBackup {
        try? fm.removeItem(at: primaryBackup)
      }
      throw (error as? FileOperationError)
        ?? .underlying(
          "copy \(sourcePrimaryURL.path) -> \(primaryDestination.path) failed: \(error.localizedDescription)"
        )
    }

    if let primaryBackup { try? fm.removeItem(at: primaryBackup) }
  }

  private static func restoreBackup(from backup: URL, to destination: URL) throws {
    let fm = FileManager.default
    if fm.fileExists(atPath: destination.path) {
      try fm.removeItem(at: destination)
    }
    try fm.moveItem(at: backup, to: destination)
  }

  static func copyVerified(from source: URL, to destination: URL) throws {
    let fm = FileManager.default
    let tmp = try stageVerifiedCopy(from: source, forDestination: destination)
    do {
      try publish(tmp, to: destination)
    } catch {
      try? fm.removeItem(at: tmp)
      throw (error as? FileOperationError)
        ?? .underlying(
          "copy \(source.path) -> \(destination.path) failed: \(error.localizedDescription)")
    }
  }

  /// The verification step in isolation — `internal` (not `private`) so
  /// tests can drive the mismatch branch directly against real,
  /// deliberately-divergent files on disk. This boundary only fires in
  /// production if the destination changes between our copy and our
  /// verify (a second writer racing the same path); it's real logic that
  /// deserves real coverage even though it's impractical to provoke
  /// end-to-end.
  static func verifyCopy(sourceSize: Int64, sourceMtime: Date?, destinationURL: URL) throws {
    let fm = FileManager.default
    guard fm.fileExists(atPath: destinationURL.path) else {
      throw FileOperationError.verificationFailed("missing destination: \(destinationURL.path)")
    }
    let destAttrs = try fm.attributesOfItem(atPath: destinationURL.path)
    let destSize = (destAttrs[.size] as? NSNumber)?.int64Value
    guard destSize == sourceSize else {
      throw FileOperationError.verificationFailed(
        "\(destinationURL.path): size \(String(describing: destSize)) != \(sourceSize)")
    }
    if let sourceMtime, let destMtime = destAttrs[.modificationDate] as? Date {
      guard
        abs(destMtime.timeIntervalSince1970 - sourceMtime.timeIntervalSince1970) < mtimeTolerance
      else {
        throw FileOperationError.verificationFailed(
          "\(destinationURL.path): mtime \(destMtime) != \(sourceMtime)")
      }
    }
  }

  // MARK: - Collision helpers

  /// Resolve a collision at `targetURL` per `collision`, returning the
  /// (possibly suffixed) final URL and whether a suffix was applied. A
  /// pure computation for every policy, including `.replace`: this
  /// deliberately does NOT pre-delete the occupant. An earlier version
  /// removed the occupant here, before the copy that followed — the
  /// "delete-then-hope" shape that, if the copy then failed (disk full, a
  /// transient IO error, a locked file), left NEITHER the old nor the new
  /// file on disk, violating this module's own "a duplicate is left on
  /// disk, never data loss" contract (found by the #2633 cross-platform
  /// parity harness — the TS and Windows twins already avoided this).
  /// `copyVerified` now publishes via a verified temp file, replacing an
  /// existing occupant ATOMICALLY at the very end — so `.replace` needs no
  /// removal step of its own; it only needs to resolve to the occupied
  /// path unchanged and let the verified publish do the replacing.
  ///
  /// A DIRECTORY sitting at the target is never a valid occupant for
  /// `.replace` — swapping a whole folder (and everything under it) for a
  /// single file is not what "replace this file" means, and the old
  /// pre-delete shape would have silently done exactly that via a
  /// recursive `removeItem`. `.fail` and `.autoSuffix` both already treat
  /// a directory as "occupied" via plain `fileExists`, so only `.replace`
  /// needs an explicit guard.
  private static func resolveCollision(
    at targetURL: URL, collision: CollisionPolicy, ownSidecar: URL?, sourcePrimaryURL: URL
  ) async throws -> (url: URL, renamed: Bool) {
    let fm = FileManager.default
    guard
      try assetDestinationOccupied(
        targetURL.path, ownSidecar: ownSidecar,
        sourcePrimaryURL: sourcePrimaryURL)
    else {
      return (targetURL, false)
    }
    switch collision {
    case .fail:
      throw FileOperationError.destinationExists(targetURL.path)
    case .replace:
      var isDirectory: ObjCBool = false
      fm.fileExists(atPath: targetURL.path, isDirectory: &isDirectory)
      guard !isDirectory.boolValue else {
        throw FileOperationError.invalidDestination(
          "cannot replace a folder with a file: \(targetURL.path)")
      }
      return (targetURL, false)
    case .autoSuffix:
      let free = try await CollisionResolver.pickFreePath(targetURL.path) { candidate in
        try assetDestinationOccupied(
          candidate, ownSidecar: ownSidecar,
          sourcePrimaryURL: sourcePrimaryURL)
      }
      return (URL(fileURLWithPath: free), true)
    }
  }

  /// Occupied for a whole asset (#4707): the primary name itself, or its
  /// derived sidecar name unless that is the moving asset's own sidecar or
  /// already holds exactly its bytes.
  private static func assetDestinationOccupied(
    _ path: String, ownSidecar: URL?, sourcePrimaryURL: URL
  ) throws -> Bool {
    let fm = FileManager.default
    guard !fm.fileExists(atPath: path) else { return true }
    if try LocalWorkflowVariants.occupied(
      at: URL(fileURLWithPath: path), excluding: sourcePrimaryURL)
    {
      return true
    }
    let sidecar = SidecarPath.sidecarURL(for: URL(fileURLWithPath: path)).path
    guard fm.fileExists(atPath: sidecar) else { return false }
    guard let own = ownSidecar?.path else { return true }
    return !SidecarOwnership.sameLocalFile(own, sidecar)
      && !SidecarOwnership.localSidecarAlreadyCarried(own, at: sidecar)
  }
}
