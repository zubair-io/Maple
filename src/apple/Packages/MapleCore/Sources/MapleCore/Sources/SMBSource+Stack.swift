import Foundation

/// A stacked RAW+JPEG tile on an SMB share (#5050): the RAW's rename, move and trash carry its
/// JPEG, through the same engines a single file uses. The shared sidecar follows the ownership
/// rule on its own: copied while the RAW's sibling still reads it, taken once the last one leaves.
extension SMBSource {
  /// Rename the RAW to `newFilename` and its JPEG to the same stem. A JPEG that cannot follow
  /// puts the RAW back under its old name.
  public func renameAsset(
    _ ref: ImageRef, companion: ImageRef, to newFilename: String, companionFilename: String,
    collision: CollisionPolicy = .fail
  ) async throws -> (primary: String, companion: String) {
    let primaryPath = try await renameAsset(ref, to: newFilename, collision: collision)
    do {
      let companionPath = try await renameAsset(
        companion, to: companionFilename, collision: collision == .replace ? .replace : .fail)
      return (primaryPath, companionPath)
    } catch {
      _ = try? await renameAsset(ref, to: ref.displayName, collision: .fail)
      throw error
    }
  }

  /// Move or copy the RAW into `destinationDir` and its JPEG after it, under the RAW's final
  /// stem. A move whose JPEG cannot follow puts the RAW back; a copy that fails midway leaves the
  /// RAW's copy behind, a duplicate rather than a loss.
  public func relocateAsset(
    _ ref: ImageRef, companion: ImageRef, to destinationDir: String, mode: RelocateMode,
    collision: CollisionPolicy
  ) async throws -> (primary: RelocateOutcome, companion: RelocateOutcome) {
    let originalDir = (try mutationPath(for: ref) as NSString).deletingLastPathComponent
    let primary = try await relocateAsset(
      ref, to: destinationDir, mode: mode, collision: collision)
    do {
      var companionOutcome = try await relocateAsset(
        companion, to: destinationDir, mode: mode,
        collision: collision == .replace ? .replace : .fail)
      let primaryStem = Self.stem(of: primary.primaryPath)
      if mode == .move, Self.stem(of: companionOutcome.primaryPath) != primaryStem {
        let aligned = Self.filename(
          stem: primaryStem, extensionOf: companionOutcome.primaryPath)
        let path = try await renameAsset(companion, to: aligned, collision: .fail)
        companionOutcome = RelocateOutcome(
          primaryPath: path, sidecarPath: companionOutcome.sidecarPath,
          renamedDueToCollision: companionOutcome.renamedDueToCollision,
          sidecarFollowed: companionOutcome.sidecarFollowed)
      }
      return (primary, companionOutcome)
    } catch {
      if mode == .move {
        _ = try? await relocateAsset(ref, to: originalDir, mode: .move, collision: .fail)
      }
      throw error
    }
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

  private static func stem(of path: String) -> String {
    ((path as NSString).lastPathComponent as NSString).deletingPathExtension
  }

  private static func filename(stem: String, extensionOf path: String) -> String {
    let ext = (path as NSString).pathExtension
    return ext.isEmpty ? stem : "\(stem).\(ext)"
  }
}
