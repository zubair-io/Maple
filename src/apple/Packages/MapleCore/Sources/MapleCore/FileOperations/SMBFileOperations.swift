// SMBFileOperations.swift — relocate primitive for the SMB source (issue
// #2631). Same shape and the same crash-safety contract as
// `LocalFileOperations` — copy → verify → sidecar-follow → delete, split
// into plan/finalize — but keyed by share-relative POSIX path strings
// (there is no local `URL`; see `SMBSource.swift`'s identical choice) and
// routed through the narrow `SMBFileTransport` protocol so tests can
// substitute an in-memory fake (see `SMBFileTransport.swift` for why).
//
// The caller supplies the already-connected `transport` (normally a live
// `SMB2Manager`) — this module owns no connection lifecycle, matching
// `SMBIdCacheStorage`'s identical choice to take a `client` rather than
// dial its own.

import Foundation
import OSLog

private let fileOpsLog = Logger(subsystem: "app.justmaple.aperture", category: "SMBFileOperations")

public enum SMBFileOperations {

  /// SMB attribute round-trips add a real network hop for comparatively
  /// little safety benefit over `LocalFileOperations`' same-machine
  /// check, so this is a looser bound than the local tolerance — still
  /// tight enough to catch a copy that landed against the wrong file.
  static let mtimeTolerance: TimeInterval = 2.0

  // MARK: - Relocate (asset-level: primary + sidecar)

  public static func relocate(
    _ sourcePrimaryPath: String,
    to destinationDir: String,
    newBasename: String? = nil,
    mode: RelocateMode,
    collision: CollisionPolicy = .autoSuffix,
    transport: SMBFileTransport
  ) async throws -> RelocateOutcome {
    let plan = try await planRelocate(
      sourcePrimaryPath, to: destinationDir, newBasename: newBasename,
      mode: mode, collision: collision, transport: transport)
    return await finalizeRelocate(plan, transport: transport)
  }

  /// Copy (never move) the primary — and its `.xmp` sidecar, if one
  /// exists — into `destinationDir`, verifying each copy. Nothing is
  /// deleted; the source is untouched no matter how this call ends. The
  /// one exception is a case-only rename (see `classifySameFile`),
  /// performed directly here as an atomic move.
  public static func planRelocate(
    _ sourcePrimaryPath: String,
    to destinationDir: String,
    newBasename: String? = nil,
    mode: RelocateMode,
    collision: CollisionPolicy = .autoSuffix,
    transport: SMBFileTransport
  ) async throws -> RelocatePlan {
    guard await exists(sourcePrimaryPath, transport: transport) else {
      throw FileOperationError.sourceMissing(sourcePrimaryPath)
    }
    if let newBasename, !FilenameValidation.isValidPathComponent(newBasename) {
      throw FileOperationError.invalidName(newBasename)
    }

    let basename = newBasename ?? posixLastComponent(sourcePrimaryPath)
    let targetPath = posixJoin(destinationDir, basename)

    switch classifySameFile(source: sourcePrimaryPath, target: targetPath) {
    case .identical:
      throw FileOperationError.sameFile(
        "destination resolves to the same file as the source: \(sourcePrimaryPath)")
    case .caseOnlyRename:
      guard mode == .move else {
        throw FileOperationError.sameFile(
          "case-only rename target is the same file as the source on a case-insensitive "
            + "share — copy is not meaningful: \(sourcePrimaryPath)")
      }
      return try await performCaseOnlyRename(
        source: sourcePrimaryPath, target: targetPath, transport: transport)
    case .different:
      break
    }

    // Best-effort: the destination directory almost always already
    // exists (moving into an existing folder); a genuinely-missing one
    // surfaces for real on the `copyItem` call that follows.
    try? await transport.createDirectory(atPath: destinationDir)
    let sourceSidecarPath = sidecarPath(for: sourcePrimaryPath)
    let hasSourceSidecar = await exists(sourceSidecarPath, transport: transport)
    let (resolvedTargetPath, renamed) = try await resolveCollision(
      at: targetPath, collision: collision,
      ownSidecar: hasSourceSidecar ? sourceSidecarPath : nil, transport: transport)
    let sidecarTargetPath = sidecarPath(for: resolvedTargetPath)

    // The shared-sidecar ownership rule (#4707, docs/xmp-canonical-format.md
    // § "Moving, renaming and trashing a photo"), decided before any byte moves.
    let sidecarMapsOntoItself = await SidecarOwnership.sameSMBFile(
      sourceSidecarPath, sidecarTargetPath, transport: transport)
    let destinationSidecarOccupied =
      sidecarMapsOntoItself ? false : await exists(sidecarTargetPath, transport: transport)
    let joinsCarriedSidecar =
      hasSourceSidecar && destinationSidecarOccupied
      ? await SidecarOwnership.smbSidecarAlreadyCarried(
        sourceSidecarPath, at: sidecarTargetPath, transport: transport)
      : false
    let destinationClaimed = await SidecarOwnership.smbStemClaimedBySibling(
      resolvedTargetPath, excluding: [sourcePrimaryPath], transport: transport)
    if hasSourceSidecar, destinationSidecarOccupied, !joinsCarriedSidecar,
      collision != .replace || destinationClaimed
    {
      throw FileOperationError.destinationExists(sidecarTargetPath)
    }
    let sourceClaimed = await SidecarOwnership.smbStemClaimedBySibling(
      sourcePrimaryPath, excluding: [resolvedTargetPath], transport: transport)
    let copiesSidecar = hasSourceSidecar && !sidecarMapsOntoItself && !joinsCarriedSidecar
    var sidecarTmp: String?

    let primaryTmp = try await stageVerifiedCopy(
      from: sourcePrimaryPath, to: resolvedTargetPath, transport: transport)
    if copiesSidecar {
      do {
        sidecarTmp = try await stageVerifiedCopy(
          from: sourceSidecarPath, to: sidecarTargetPath, transport: transport)
      } catch {
        try? await transport.removeItem(atPath: primaryTmp)
        throw error
      }
    }

    var createdPaths: [String] = []
    let primaryBackup: String?
    do {
      primaryBackup = try await stagePublish(
        primaryTmp, to: resolvedTargetPath, allowReplace: collision == .replace,
        transport: transport)
    } catch {
      try? await transport.removeItem(atPath: primaryTmp)
      if let sidecarTmp { try? await transport.removeItem(atPath: sidecarTmp) }
      throw (error as? FileOperationError)
        ?? .underlying(
          "copy \(sourcePrimaryPath) -> \(resolvedTargetPath) failed: \(error.localizedDescription)"
        )
    }
    createdPaths.append(resolvedTargetPath)

    if let sidecarTmp {
      do {
        if let sidecarBackup = try await stagePublish(
          sidecarTmp, to: sidecarTargetPath, allowReplace: true, transport: transport)
        {
          try? await transport.removeItem(atPath: sidecarBackup)
        }
      } catch {
        try? await transport.removeItem(atPath: sidecarTmp)
        try? await transport.removeItem(atPath: resolvedTargetPath)
        if let primaryBackup {
          try? await transport.moveItem(atPath: primaryBackup, toPath: resolvedTargetPath)
        }
        throw (error as? FileOperationError)
          ?? .underlying(
            "copy \(sourceSidecarPath) -> \(sidecarTargetPath) failed: \(error.localizedDescription)"
          )
      }
      createdPaths.append(sidecarTargetPath)
    } else if !hasSourceSidecar, collision == .replace, !destinationClaimed {
      let staleSidecarPath = sidecarPath(for: resolvedTargetPath)
      if let attrs = try? await transport.attributesOfItem(atPath: staleSidecarPath),
        !isDirectory(attrs)
      {
        try? await transport.removeItem(atPath: staleSidecarPath)
      }
    }
    if let primaryBackup {
      try? await transport.removeItem(atPath: primaryBackup)
    }

    return RelocatePlan(
      mode: mode, sourcePrimaryPath: sourcePrimaryPath,
      sourceSidecarPath: hasSourceSidecar ? sourceSidecarPath : nil,
      finalPrimaryPath: resolvedTargetPath,
      finalSidecarPath: hasSourceSidecar ? sidecarTargetPath : nil,
      renamedDueToCollision: renamed, createdPaths: createdPaths,
      retainsSourceSidecar: sidecarMapsOntoItself || sourceClaimed)
  }

  /// Delete the sources (`mode == .move` only) and clear the OLD
  /// location's on-share derived thumb/preview entries
  /// (`invalidateDerivedCaches`). Best-effort throughout, matching the
  /// local engine — a copy-succeeded-but-delete-failed leaves a
  /// duplicate, never data loss; a failure is logged (`fileOpsLog`), not
  /// thrown.
  ///
  /// The one step the local engine has that this deliberately does NOT
  /// mirror is the `LibraryIndex` refresh: the AMSMB2 browse path never
  /// reads a per-folder index (that's a `FilesystemSource` cold-open
  /// cache), the index is non-authoritative (culling truth lives in the
  /// `.xmp`, which relocates with the asset), and rewriting on-share
  /// JSON over the transport would cost read-modify-write round-trips
  /// for a cache whose stale entry is just an orphan the next
  /// mounted-folder rebuild reconciles.
  @discardableResult
  public static func finalizeRelocate(_ plan: RelocatePlan, transport: SMBFileTransport) async
    -> RelocateOutcome
  {
    let outcome = RelocateOutcome(
      primaryPath: plan.finalPrimaryPath, sidecarPath: plan.finalSidecarPath,
      renamedDueToCollision: plan.renamedDueToCollision,
      sidecarFollowed: plan.finalSidecarPath != nil
    )
    guard !plan.isNoop, plan.mode == .move else { return outcome }

    do {
      try await transport.removeItem(atPath: plan.sourcePrimaryPath)
    } catch {
      fileOpsLog.error(
        "finalizeRelocate: source primary remove failed after a verified copy — a duplicate is left on the share (\(plan.sourcePrimaryPath, privacy: .public)): \(error.localizedDescription, privacy: .public)"
      )
    }
    if let sourceSidecarPath = plan.sourceSidecarPath, !plan.retainsSourceSidecar {
      do {
        try await transport.removeItem(atPath: sourceSidecarPath)
      } catch {
        fileOpsLog.error(
          "finalizeRelocate: source sidecar remove failed after a verified copy (\(sourceSidecarPath, privacy: .public)): \(error.localizedDescription, privacy: .public)"
        )
      }
    }
    await invalidateDerivedCaches(forOldPrimaryPath: plan.sourcePrimaryPath, transport: transport)
    return outcome
  }

  // MARK: - Derived-cache invalidation

  /// Delete the OLD location's on-share derived thumb + preview entries
  /// (`.maple/thumbs/<filename.ext>.avif` and
  /// `.maple/previews/<basename>.avif`, via `MapleSidecarPaths`). These
  /// are NOT an Apple-local cache this client would have written: they're
  /// the cross-layer, path-keyed, travels-with-the-photos derivative
  /// contract (`MapleSidecarPaths` = the API's `resolveThumbPath` /
  /// `resolveCachePath` = the web maple-cache), and a share reached over
  /// AMSMB2 can already carry entries written by the Self Hosted
  /// indexer, Web Hosted, or a Mac browsing the same share through a
  /// Finder mount. The Apple and Web read paths resolve them by basename
  /// with no freshness check, so a stale entry left at the old location
  /// would serve the WRONG pixels for any different file that later
  /// lands there under the same name — the same reasoning as
  /// `LocalFileOperations.invalidateDerivedCaches`, whose two call sites
  /// (`finalizeRelocate`, `performCaseOnlyRename`) this engine mirrors.
  /// Best-effort: on most shares neither entry exists and the removes
  /// just fail, swallowed.
  static func invalidateDerivedCaches(
    forOldPrimaryPath oldPrimaryPath: String, transport: SMBFileTransport
  ) async {
    // Same pure-lexical URL wrapping as `sidecarPath(for:)` below —
    // no filesystem access, just shared path math.
    let oldURL = URL(fileURLWithPath: oldPrimaryPath)
    let derivatives = [
      MapleSidecarPaths.thumbURL(for: oldURL), MapleSidecarPaths.legacyThumbURL(for: oldURL),
      MapleSidecarPaths.previewURL(for: oldURL), MapleSidecarPaths.legacyPreviewURL(for: oldURL),
    ]
    for derivative in derivatives {
      try? await transport.removeItem(atPath: derivative.path)
    }
    // #2946: the two removes above only clear the on-SHARE, cross-layer
    // thumb/preview entries. `RenderedPreviewCache` is a SEPARATE,
    // per-device cold-open cache (docs/caching.md § 3) keyed on a hash
    // of the asset's URL — `EditSession` uses it for every source,
    // `smb://`-backed ones included — that a bare share-side
    // `removeItem` never touches. `LocalFileOperations
    // .invalidateDerivedCaches` already calls this for the same reason
    // (#2659: "an actual unbounded leak" without it); this engine had
    // never mirrored it, so a moved/trashed SMB photo left a stale
    // rendered JPEG (memory AND disk) at the old URL hash forever.
    await RenderedPreviewCache.shared.invalidate(assetURL: oldURL)
  }

  /// Undo a plan that will never be finalized — removes the staged
  /// copies, leaving the source exactly as it was before `planRelocate`.
  public static func revertPlan(_ plan: RelocatePlan, transport: SMBFileTransport) async {
    for path in plan.createdPaths {
      try? await transport.removeItem(atPath: path)
    }
  }

  // MARK: - Same-file / case-only-rename guard

  /// Classifies whether `source` and `target` name the same file on the
  /// share, versus merely differing in case on a case-insensitive-but-
  /// case-preserving share (the Windows/Samba default) versus genuinely
  /// different locations. See `LocalFileOperations.classifySameFile` for
  /// the full safety rationale — the property protected is identical:
  /// `.replace`'s pre-copy removal must never delete the source itself.
  ///
  /// Limitation vs. the local engine: SMB has no local realpath/symlink
  /// resolution available through `SMBFileTransport`, so this can only
  /// compare the paths AS GIVEN — a destination reached via a different
  /// mount point or a server-side symlink/junction to the same target is
  /// NOT detected here. Case-only-rename detection (the other half of
  /// the guard) has no such gap: it's pure string comparison and doesn't
  /// depend on resolving anything.
  static func classifySameFile(source: String, target: String) -> SameFileClassification {
    if source == target { return .identical }
    if source.caseInsensitiveCompare(target) == .orderedSame { return .caseOnlyRename }
    return .different
  }

  /// The ONE relocate shape that bypasses copy-verify-delete AND
  /// collision handling entirely — see
  /// `LocalFileOperations.performCaseOnlyRename`'s doc comment for the
  /// full rationale; `transport.moveItem` is the SMB equivalent of a
  /// local atomic `rename(2)`.
  private static func performCaseOnlyRename(
    source: String, target: String, transport: SMBFileTransport
  ) async throws -> RelocatePlan {
    let sourceSidecarPath = sidecarPath(for: source)
    let hadSidecar = await exists(sourceSidecarPath, transport: transport)

    try await transport.moveItem(atPath: source, toPath: target)

    var finalSidecarPath: String?
    var resolvedSourceSidecarPath: String?
    if hadSidecar {
      let targetSidecarPath = sidecarPath(for: target)
      resolvedSourceSidecarPath = sourceSidecarPath
      // The transport reports no case sensitivity, so a case-only rename on a
      // share that does not fold case names a second file: the sidecar then
      // follows the shared-sidecar rule instead of the re-spelling (#4707).
      let sameFile = await SidecarOwnership.sameSMBFile(
        sourceSidecarPath, targetSidecarPath, transport: transport)
      let occupied = sameFile ? false : await exists(targetSidecarPath, transport: transport)
      let claimed =
        sameFile || occupied
        ? false
        : await SidecarOwnership.smbStemClaimedBySibling(
          source, excluding: [target], transport: transport)
      do {
        switch (sameFile, occupied, claimed) {
        case (true, _, _):
          try await transport.moveItem(atPath: sourceSidecarPath, toPath: targetSidecarPath)
        case (false, true, _):
          fileOpsLog.notice(
            "performCaseOnlyRename: destination sidecar already exists, leaving the source sidecar in place (\(targetSidecarPath, privacy: .public))"
          )
        case (false, false, true):
          try await copyVerified(
            from: sourceSidecarPath, to: targetSidecarPath, transport: transport)
        case (false, false, false):
          try await transport.moveItem(atPath: sourceSidecarPath, toPath: targetSidecarPath)
        }
      } catch {
        fileOpsLog.error(
          "performCaseOnlyRename: sidecar follow failed (\(sourceSidecarPath, privacy: .public)): \(error.localizedDescription, privacy: .public)"
        )
      }
      finalSidecarPath =
        await exists(targetSidecarPath, transport: transport) ? targetSidecarPath : nil
    }

    // Inline cache cleanup, matching `LocalFileOperations`' identical
    // choice: `finalize` is a no-op for this plan (`isNoop`), and the
    // old-cased basename is a different hash input / preview filename,
    // so its entries are exactly as stale as after a real move.
    await invalidateDerivedCaches(forOldPrimaryPath: source, transport: transport)
    return RelocatePlan(
      mode: .move, sourcePrimaryPath: source, sourceSidecarPath: resolvedSourceSidecarPath,
      finalPrimaryPath: target, finalSidecarPath: finalSidecarPath,
      renamedDueToCollision: false, createdPaths: [], sourceAlreadyRelocated: true)
  }

  // MARK: - Copy + verify

  static func copyVerified(
    from source: String, to destination: String, allowReplace: Bool = false,
    transport: SMBFileTransport
  ) async throws {
    let tmp = try await stageVerifiedCopy(from: source, to: destination, transport: transport)
    do {
      if let backup = try await stagePublish(
        tmp, to: destination, allowReplace: allowReplace, transport: transport)
      {
        try? await transport.removeItem(atPath: backup)
      }
    } catch {
      try? await transport.removeItem(atPath: tmp)
      throw (error as? FileOperationError)
        ?? .underlying(
          "copy \(source) -> \(destination) failed: \(error.localizedDescription)")
    }
  }

  private static func stageVerifiedCopy(
    from source: String, to destination: String, transport: SMBFileTransport
  ) async throws -> String {
    let tmp = tempPath(for: destination)
    do {
      let sourceAttrs = try await transport.attributesOfItem(atPath: source)
      guard let sourceSize = (sourceAttrs[.fileSizeKey] as? NSNumber)?.int64Value else {
        throw FileOperationError.underlying("could not read size of \(source)")
      }
      let sourceMtime = sourceAttrs[.contentModificationDateKey] as? Date

      try await transport.copyItem(atPath: source, toPath: tmp, recursive: false, progress: nil)
      if let sourceMtime {
        try? await transport.setAttributes(
          attributes: [.contentModificationDateKey: sourceMtime], ofItemAtPath: tmp)
      }
      try await verifyCopy(
        sourceSize: sourceSize, sourceMtime: sourceMtime,
        destinationPath: tmp, transport: transport)
      return tmp
    } catch {
      try? await transport.removeItem(atPath: tmp)
      throw (error as? FileOperationError)
        ?? .underlying(
          "copy \(source) -> \(destination) failed: \(error.localizedDescription)")
    }
  }

  /// Publish a verified temp sibling over `destination` without ever
  /// deleting an existing occupant before the replacement is verified on
  /// the share (#4703). When `allowReplace` is `false` (`.fail` /
  /// `.autoSuffix`), any occupant that appeared after `resolveCollision`
  /// is refused with `.destinationExists`. When `allowReplace` is `true`,
  /// an existing file occupant is parked at a hidden sibling path in the
  /// same directory (staying out of `/.maple/trash` and requiring no
  /// share-root write permissions) and returned so the caller can roll
  /// back or delete it after any companion sidecar publish completes.
  private static func stagePublish(
    _ tmp: String, to destination: String, allowReplace: Bool, transport: SMBFileTransport
  ) async throws -> String? {
    guard let destAttrs = try? await transport.attributesOfItem(atPath: destination) else {
      do {
        try await transport.moveItem(atPath: tmp, toPath: destination)
        return nil
      } catch let error as POSIXError where error.code == .EEXIST && !allowReplace {
        throw FileOperationError.destinationExists(destination)
      }
    }
    guard !isDirectory(destAttrs) else {
      throw FileOperationError.invalidDestination(
        "cannot replace a folder with a file: \(destination)")
    }
    guard allowReplace else {
      throw FileOperationError.destinationExists(destination)
    }
    let backupPath = replaceBackupPath(for: destination)
    try await transport.moveItem(atPath: destination, toPath: backupPath)
    do {
      try await transport.moveItem(atPath: tmp, toPath: destination)
    } catch {
      try? await transport.moveItem(atPath: backupPath, toPath: destination)
      throw error
    }
    return backupPath
  }

  private static func tempPath(for destination: String) -> String {
    let dir = (destination as NSString).deletingLastPathComponent
    return posixJoin(dir, ".maple-stage-\(UUID().uuidString)")
  }

  private static func replaceBackupPath(for destination: String) -> String {
    let dir = (destination as NSString).deletingLastPathComponent
    return posixJoin(dir, ".maple-backup-\(UUID().uuidString)")
  }

  private static func isDirectory(_ attrs: [URLResourceKey: Any]) -> Bool {
    if let flag = attrs[.isDirectoryKey] as? Bool { return flag }
    if let num = attrs[.isDirectoryKey] as? NSNumber { return num.boolValue }
    return false
  }

  /// `internal` (not `private`) for the same reason as the local engine's
  /// `verifyCopy` — real coverage of the mismatch branch against a
  /// deliberately-divergent fake destination.
  static func verifyCopy(
    sourceSize: Int64, sourceMtime: Date?, destinationPath: String,
    transport: SMBFileTransport
  ) async throws {
    guard let destAttrs = try? await transport.attributesOfItem(atPath: destinationPath) else {
      throw FileOperationError.verificationFailed("missing destination: \(destinationPath)")
    }
    let destSize = (destAttrs[.fileSizeKey] as? NSNumber)?.int64Value
    guard destSize == sourceSize else {
      throw FileOperationError.verificationFailed(
        "\(destinationPath): size \(String(describing: destSize)) != \(sourceSize)")
    }
    if let sourceMtime, let destMtime = destAttrs[.contentModificationDateKey] as? Date {
      guard
        abs(destMtime.timeIntervalSince1970 - sourceMtime.timeIntervalSince1970) < mtimeTolerance
      else {
        throw FileOperationError.verificationFailed(
          "\(destinationPath): mtime \(destMtime) != \(sourceMtime)")
      }
    }
  }

  // MARK: - Collision + path helpers

  /// Resolve a collision at `targetPath` per `collision`, returning the
  /// (possibly suffixed) final path and whether a suffix was applied.
  /// Mirrors `LocalFileOperations.resolveCollision`.
  private static func resolveCollision(
    at targetPath: String, collision: CollisionPolicy, ownSidecar: String?,
    transport: SMBFileTransport
  ) async throws -> (path: String, renamed: Bool) {
    let occupied = { (candidate: String) in
      await assetDestinationOccupied(candidate, ownSidecar: ownSidecar, transport: transport)
    }
    guard await occupied(targetPath) else { return (targetPath, false) }
    let attrs = (try? await transport.attributesOfItem(atPath: targetPath)) ?? [:]
    switch collision {
    case .fail:
      throw FileOperationError.destinationExists(targetPath)
    case .replace:
      guard !isDirectory(attrs) else {
        throw FileOperationError.invalidDestination(
          "cannot replace a folder with a file: \(targetPath)")
      }
      // The occupant is replaced in `copyVerified`'s `publish` step
      // AFTER the temp sibling has been copied and verified — never
      // deleted up front (#4703).
      return (targetPath, false)
    case .autoSuffix:
      return (try await CollisionResolver.pickFreePath(targetPath, exists: occupied), true)
    }
  }

  /// Occupied for a whole asset (#4707): the primary name itself, or its
  /// derived sidecar name unless that is the moving asset's own sidecar or
  /// already holds exactly its bytes.
  private static func assetDestinationOccupied(
    _ path: String, ownSidecar: String?, transport: SMBFileTransport
  ) async -> Bool {
    guard await !exists(path, transport: transport) else { return true }
    let sidecar = sidecarPath(for: path)
    guard await exists(sidecar, transport: transport) else { return false }
    guard let own = ownSidecar else { return true }
    guard await !SidecarOwnership.sameSMBFile(own, sidecar, transport: transport) else {
      return false
    }
    return await !SidecarOwnership.smbSidecarAlreadyCarried(own, at: sidecar, transport: transport)
  }

  static func exists(_ path: String, transport: SMBFileTransport) async -> Bool {
    (try? await transport.attributesOfItem(atPath: path)) != nil
  }

  static func posixLastComponent(_ path: String) -> String {
    (path as NSString).lastPathComponent
  }

  static func posixJoin(_ dir: String, _ name: String) -> String {
    (dir as NSString).appendingPathComponent(name)
  }

  /// Sidecar path for an SMB share-relative path — reuses `SidecarPath`'s
  /// video/image split by wrapping the string in a `URL(fileURLWithPath:)`
  /// purely for its lexical path-component logic. No filesystem access
  /// happens: an SMB path isn't a real local path, but extension/stem
  /// manipulation is pure string math that works identically either way.
  static func sidecarPath(for primaryPath: String) -> String {
    SidecarPath.sidecarURL(for: URL(fileURLWithPath: primaryPath)).path
  }
}
