import Foundation

/// A stacked RAW+JPEG tile on an SMB share (#5050): the RAW's rename, move and trash carry its
/// JPEG, through the same engines a single file uses. The shared sidecar follows the ownership
/// rule on its own: copied while the RAW's sibling still reads it, taken once the last one leaves.
///
/// One tile, two file operations: the RAW's collision choice never reaches the JPEG. Both names
/// are decided before either file moves, the JPEG goes straight to the RAW's final stem, and a JPEG
/// that cannot follow a move puts the RAW back under its original name.
extension SMBSource {
  /// Rename the RAW to `newFilename` and its JPEG to the same stem (keeping the JPEG's extension).
  /// `collision` is the RAW's policy; `companionCollision` is the JPEG's own, `.replace` only after
  /// a prompt that named the JPEG.
  public func renameAsset(
    _ ref: ImageRef, companion: ImageRef, to newFilename: String,
    collision: CollisionPolicy = .fail, companionCollision: CollisionPolicy = .fail
  ) async throws -> (primary: String, companion: String) {
    let sourceDir = (try mutationPath(for: ref) as NSString).deletingLastPathComponent
    let outcome = try await relocateStack(
      ref, companion: companion, to: sourceDir, primaryName: newFilename, mode: .move,
      collision: collision, companionCollision: companionCollision)
    return (outcome.primary.primaryPath, outcome.companion.primaryPath)
  }

  /// Move or copy the RAW and its JPEG into `destinationDir` under one stem. `.autoSuffix` picks a
  /// stem free for the RAW, the JPEG and their sidecar; `.fail` and `.replace` throw
  /// `destinationExists` naming the JPEG when only its name is taken (unless `companionCollision`
  /// is `.replace`). A move whose JPEG cannot follow puts the RAW back under its original name; a
  /// copy that fails midway leaves the RAW's copy behind, a duplicate rather than a loss.
  public func relocateAsset(
    _ ref: ImageRef, companion: ImageRef, to destinationDir: String, mode: RelocateMode,
    collision: CollisionPolicy, companionCollision: CollisionPolicy = .fail
  ) async throws -> (primary: RelocateOutcome, companion: RelocateOutcome) {
    let primaryName = Self.lastComponent(try mutationPath(for: ref))
    return try await relocateStack(
      ref, companion: companion, to: destinationDir, primaryName: primaryName, mode: mode,
      collision: collision, companionCollision: companionCollision)
  }

  /// Trash the JPEG, then the RAW: a RAW that then fails to trash is still whole.
  public func trashAsset(_ ref: ImageRef, companion: ImageRef) async throws -> RelocateOutcome {
    let companionOutcome = try await trashAsset(companion)
    let primary = try await trashAsset(ref)
    return RelocateOutcome(
      primaryPath: primary.primaryPath, sidecarPath: primary.sidecarPath,
      renamedDueToCollision: primary.renamedDueToCollision,
      sidecarFollowed: primary.sidecarFollowed, companionPath: companionOutcome.primaryPath)
  }

  private func relocateStack(
    _ ref: ImageRef, companion: ImageRef, to destinationDir: String, primaryName: String,
    mode: RelocateMode, collision: CollisionPolicy, companionCollision: CollisionPolicy
  ) async throws -> (primary: RelocateOutcome, companion: RelocateOutcome) {
    guard let client else { throw SMBError.notConnected }
    if !FilenameValidation.isValidPathComponent(primaryName) {
      throw FileOperationError.invalidName(primaryName)
    }
    let pair = SMBStackPair(
      primary: try mutationPath(for: ref), companion: try mutationPath(for: companion),
      destination: destinationDir, primaryName: primaryName)
    let companionReplaces = collision != .autoSuffix && companionCollision == .replace
    let stem = try await Self.resolveStem(
      pair, collision: collision, companionReplaces: companionReplaces, transport: client)
    let primaryTarget = Self.lastComponent(pair.primaryTarget(stem: stem.value))
    let companionTarget = Self.lastComponent(pair.companionTarget(stem: stem.value))

    // A JPEG this operation replaces too no longer claims the destination's sidecar.
    var primary = try await relocateAsset(
      ref, to: destinationDir, newBasename: primaryTarget, mode: mode,
      collision: collision == .replace ? .replace : .fail,
      displacing: companionReplaces ? [pair.companionTarget(stem: stem.value)] : [])
    if stem.suffixed {
      primary = RelocateOutcome(
        primaryPath: primary.primaryPath, sidecarPath: primary.sidecarPath,
        renamedDueToCollision: true, sidecarFollowed: primary.sidecarFollowed)
    }
    guard pair.companionTarget(stem: stem.value) != pair.companion else {
      let unchanged = RelocateOutcome(
        primaryPath: pair.companion, sidecarPath: nil, renamedDueToCollision: false,
        sidecarFollowed: false)
      return (primary, unchanged)
    }
    do {
      let companionOutcome = try await relocateAsset(
        companion, to: destinationDir, newBasename: companionTarget, mode: mode,
        collision: companionReplaces ? .replace : .fail)
      return (primary, companionOutcome)
    } catch {
      if mode == .move {
        _ = try? await relocateAsset(
          ref, to: (pair.primary as NSString).deletingLastPathComponent,
          newBasename: Self.lastComponent(pair.primary), mode: .move, collision: .fail)
      }
      throw error
    }
  }

  /// The stem both files land under, decided before either moves.
  private static func resolveStem(
    _ pair: SMBStackPair, collision: CollisionPolicy, companionReplaces: Bool,
    transport: SMBFileTransport
  ) async throws -> (value: String, suffixed: Bool) {
    let stem = pair.requestedStem
    let primaryTarget = pair.primaryTarget(stem: stem)
    let companionTarget = pair.companionTarget(stem: stem)
    switch collision {
    case .fail:
      if await primaryOccupied(pair, at: primaryTarget, transport: transport) {
        throw FileOperationError.destinationExists(primaryTarget)
      }
      if !companionReplaces,
        await companionOccupied(pair, at: companionTarget, transport: transport)
      {
        throw FileOperationError.destinationExists(companionTarget)
      }
    case .replace:
      if !companionReplaces,
        await companionOccupied(pair, at: companionTarget, transport: transport)
      {
        throw FileOperationError.destinationExists(companionTarget)
      }
    case .autoSuffix:
      let free = try await CollisionResolver.pickFreePath(primaryTarget) { candidate in
        let candidateStem = ((lastComponent(candidate)) as NSString).deletingPathExtension
        if await primaryOccupied(
          pair, at: pair.primaryTarget(stem: candidateStem), transport: transport)
        {
          return true
        }
        return await companionOccupied(
          pair, at: pair.companionTarget(stem: candidateStem), transport: transport)
      }
      let freeStem = (lastComponent(free) as NSString).deletingPathExtension
      return (freeStem, freeStem != stem)
    }
    return (stem, false)
  }

  /// The RAW's name is taken: the file itself, or a sidecar that is not its own.
  private static func primaryOccupied(
    _ pair: SMBStackPair, at target: String, transport: SMBFileTransport
  ) async -> Bool {
    guard SMBFileOperations.classifySameFile(source: pair.primary, target: target) == .different
    else { return false }
    let ownSidecar = SMBFileOperations.sidecarPath(for: pair.primary)
    let hasOwnSidecar = await SMBFileOperations.exists(ownSidecar, transport: transport)
    return await SMBFileOperations.assetDestinationOccupied(
      target, ownSidecar: hasOwnSidecar ? ownSidecar : nil, transport: transport)
  }

  /// The JPEG's name is taken by another file. The shared sidecar is the RAW's to resolve.
  private static func companionOccupied(
    _ pair: SMBStackPair, at target: String, transport: SMBFileTransport
  ) async -> Bool {
    guard SMBFileOperations.classifySameFile(source: pair.companion, target: target) == .different
    else { return false }
    return await SMBFileOperations.exists(target, transport: transport)
  }

  fileprivate static func lastComponent(_ path: String) -> String {
    (path as NSString).lastPathComponent
  }
}

/// The two share paths and where they are headed, named by a stem.
private struct SMBStackPair {
  let primary: String
  let companion: String
  let destination: String
  let primaryName: String

  var requestedStem: String { (primaryName as NSString).deletingPathExtension }

  func primaryTarget(stem: String) -> String {
    let ext = (primaryName as NSString).pathExtension
    return SMBFileOperations.posixJoin(destination, ext.isEmpty ? stem : "\(stem).\(ext)")
  }

  /// The JPEG keeps its own name while the RAW's stem is unchanged, else takes the new stem.
  func companionTarget(stem: String) -> String {
    let companionName = (companion as NSString).lastPathComponent
    let originalStem = ((primary as NSString).lastPathComponent as NSString)
      .deletingPathExtension
    guard stem != originalStem else {
      return SMBFileOperations.posixJoin(destination, companionName)
    }
    let ext = (companionName as NSString).pathExtension
    return SMBFileOperations.posixJoin(destination, ext.isEmpty ? stem : "\(stem).\(ext)")
  }
}
