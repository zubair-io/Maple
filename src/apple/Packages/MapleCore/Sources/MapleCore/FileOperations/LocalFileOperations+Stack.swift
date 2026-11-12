// LocalFileOperations+Stack.swift — the RAW+JPEG stack carried through relocate and trash (#5050).
// A stacked Library tile is the RAW; its same-stem JPEG follows it, so one action leaves neither
// file behind. The two share one XMP sidecar, which the shared-sidecar ownership rule
// (`SidecarOwnership`) already copies, never takes, until the last sibling leaves.
//
// One tile, two file operations: a collision choice made for the RAW never reaches the JPEG. The
// JPEG only replaces an occupant when the caller passes `companionCollision: .replace` after a
// prompt that named the JPEG; Keep Both picks one stem free for the RAW, the JPEG and the sidecar.

import Foundation

extension LocalFileOperations {

  /// Relocate `primaryURL` and its stacked JPEG together.
  ///
  /// Every collision is decided before a byte is copied: `.fail` throws `destinationExists` naming
  /// whichever file is taken (the RAW's path or the JPEG's), `.replace` replaces the RAW and throws
  /// for an occupied JPEG name unless `companionCollision` is `.replace`, and `.autoSuffix` moves
  /// both to the first stem free for the RAW, the JPEG and their sidecar. Any occupant a replace
  /// displaces is backed up first and only discarded once both files are in place, so a pair that
  /// cannot finish puts the displaced files back and leaves the sources where they were.
  static func relocateStack(
    _ primaryURL: URL, companion companionURL: URL, to destinationDir: URL,
    newBasename: String?, mode: RelocateMode, collision: CollisionPolicy,
    companionCollision: CollisionPolicy
  ) async throws -> RelocateOutcome {
    if let newBasename, !FilenameValidation.isValidPathComponent(newBasename) {
      throw FileOperationError.invalidName(newBasename)
    }
    // `planRelocate` creates the destination too; the probes below list it.
    try FileManager.default.createDirectory(at: destinationDir, withIntermediateDirectories: true)
    let pair = StackPair(
      primary: primaryURL, companion: companionURL, destination: destinationDir,
      primaryName: newBasename ?? primaryURL.lastPathComponent)
    let companionReplaces = collision != .autoSuffix && companionCollision == .replace
    let stem = try await resolveStem(
      pair, collision: collision, companionReplaces: companionReplaces)
    let primaryTarget = pair.primaryTarget(stem: stem.value)
    let companionTarget = pair.companionTarget(stem: stem.value)

    let backups = try backUpOccupants(
      collision == .replace || companionReplaces
        ? [primaryTarget, companionTarget, SidecarPath.sidecarURL(for: primaryTarget)] : [],
      excluding: [primaryURL, companionURL, SidecarPath.sidecarURL(for: primaryURL)])
    let primaryPlan: RelocatePlan
    do {
      primaryPlan = try await planRelocate(
        primaryURL, to: destinationDir, newBasename: primaryTarget.lastPathComponent, mode: mode,
        collision: collision == .replace ? .replace : .fail,
        displacing: companionReplaces ? [companionTarget] : [])
    } catch {
      restore(backups)
      throw error
    }
    var companionPlan: RelocatePlan?
    if classifySameFile(source: companionURL, target: companionTarget) != .identical {
      do {
        companionPlan = try await planRelocate(
          companionURL, to: destinationDir, newBasename: companionTarget.lastPathComponent,
          mode: mode, collision: companionReplaces ? .replace : .fail,
          alsoLeaving: [primaryURL])
      } catch {
        await withdraw(primaryPlan, from: primaryURL)
        restore(backups)
        throw error
      }
    }
    let primary = await finalizeRelocate(primaryPlan)
    var companion: RelocateOutcome?
    if let companionPlan { companion = await finalizeRelocate(companionPlan) }
    discard(backups)
    return RelocateOutcome(
      primaryPath: primary.primaryPath, sidecarPath: primary.sidecarPath,
      renamedDueToCollision: stem.suffixed || primary.renamedDueToCollision,
      sidecarFollowed: primary.sidecarFollowed,
      companionPath: companion?.primaryPath ?? companionURL.path)
  }

  /// The JPEG keeps its own name unless the RAW's stem changed (a rename, or a collision suffix),
  /// in which case it takes the RAW's new stem with its own extension.
  static func companionBasename(
    companion: URL, primary: URL, relocatedPrimaryPath: String
  ) -> String {
    let relocatedStem = URL(fileURLWithPath: relocatedPrimaryPath).deletingPathExtension()
      .lastPathComponent
    guard relocatedStem != primary.deletingPathExtension().lastPathComponent else {
      return companion.lastPathComponent
    }
    return companion.pathExtension.isEmpty
      ? relocatedStem : "\(relocatedStem).\(companion.pathExtension)"
  }

  /// The two sources and where they are headed, named by a stem.
  private struct StackPair {
    let primary: URL
    let companion: URL
    let destination: URL
    let primaryName: String

    var requestedStem: String { (primaryName as NSString).deletingPathExtension }

    func primaryTarget(stem: String) -> URL {
      let ext = (primaryName as NSString).pathExtension
      return destination.appendingPathComponent(ext.isEmpty ? stem : "\(stem).\(ext)")
    }

    func companionTarget(stem: String) -> URL {
      destination.appendingPathComponent(
        companionBasename(
          companion: companion, primary: primary,
          relocatedPrimaryPath: primaryTarget(stem: stem).path))
    }
  }

  /// The stem both files land under, decided before anything is copied.
  private static func resolveStem(
    _ pair: StackPair, collision: CollisionPolicy, companionReplaces: Bool
  ) async throws -> (value: String, suffixed: Bool) {
    let stem = pair.requestedStem
    let primaryTarget = pair.primaryTarget(stem: stem)
    let companionTarget = pair.companionTarget(stem: stem)
    switch collision {
    case .fail:
      if try primaryOccupied(pair, at: primaryTarget) {
        throw FileOperationError.destinationExists(primaryTarget.path)
      }
      if !companionReplaces, try companionFileOccupied(pair, at: companionTarget) {
        throw FileOperationError.destinationExists(companionTarget.path)
      }
    case .replace:
      if !companionReplaces, try companionFileOccupied(pair, at: companionTarget) {
        throw FileOperationError.destinationExists(companionTarget.path)
      }
    case .autoSuffix:
      let free = try await CollisionResolver.pickFreePath(primaryTarget.path) { candidate in
        let candidateStem = URL(fileURLWithPath: candidate).deletingPathExtension()
          .lastPathComponent
        let primaryCandidate = pair.primaryTarget(stem: candidateStem)
        return try primaryOccupied(pair, at: primaryCandidate)
          || companionFileOccupied(pair, at: pair.companionTarget(stem: candidateStem))
      }
      let freeStem = URL(fileURLWithPath: free).deletingPathExtension().lastPathComponent
      return (freeStem, freeStem != stem)
    }
    return (stem, false)
  }

  /// The RAW's name is taken: the file itself, a workflow branch, or a sidecar that is not its own.
  private static func primaryOccupied(_ pair: StackPair, at target: URL) throws -> Bool {
    guard classifySameFile(source: pair.primary, target: target) == .different else {
      return false
    }
    let ownSidecar = SidecarPath.sidecarURL(for: pair.primary)
    return try assetDestinationOccupied(
      target.path,
      ownSidecar: FileManager.default.fileExists(atPath: ownSidecar.path) ? ownSidecar : nil,
      sourcePrimaryURL: pair.primary)
  }

  /// The JPEG's name is taken by another file or workflow branch. The shared sidecar is the RAW's
  /// to resolve, so it is not counted here.
  private static func companionFileOccupied(_ pair: StackPair, at target: URL) throws -> Bool {
    guard classifySameFile(source: pair.companion, target: target) == .different else {
      return false
    }
    if FileManager.default.fileExists(atPath: target.path) { return true }
    return try LocalWorkflowVariants.occupied(at: target, excluding: pair.companion)
  }

  /// Verified copies of every regular file at `paths` a replace could displace, so a pair that
  /// fails halfway can put them back.
  private static func backUpOccupants(_ paths: [URL], excluding sources: [URL]) throws
    -> [(backup: URL, original: URL)]
  {
    let fm = FileManager.default
    var backups: [(backup: URL, original: URL)] = []
    for path in paths {
      let isSource = sources.contains { SidecarOwnership.sameLocalFile($0.path, path.path) }
      guard !isSource, !backups.contains(where: { $0.original == path }),
        (try? fm.attributesOfItem(atPath: path.path)[.type] as? FileAttributeType)
          == .typeRegular
      else { continue }
      do {
        backups.append((try stageVerifiedCopy(from: path, forDestination: path), path))
      } catch {
        discard(backups)
        throw error
      }
    }
    return backups
  }

  private static func restore(_ backups: [(backup: URL, original: URL)]) {
    for item in backups {
      do {
        try restoreBackup(from: item.backup, to: item.original)
      } catch {
        // Keep the backup on disk rather than lose the displaced file.
        continue
      }
    }
  }

  private static func discard(_ backups: [(backup: URL, original: URL)]) {
    for item in backups { try? FileManager.default.removeItem(at: item.backup) }
  }

  /// Undo a primary plan whose companion could not be planned. A staged copy is removed; a
  /// case-only rename already happened in place, so it is renamed back.
  private static func withdraw(_ plan: RelocatePlan, from source: URL) async {
    guard plan.sourceAlreadyRelocated else {
      revertPlan(plan)
      return
    }
    _ = try? await planRelocate(
      URL(fileURLWithPath: plan.finalPrimaryPath), to: source.deletingLastPathComponent(),
      newBasename: source.lastPathComponent, mode: .move, collision: .fail)
  }
}
