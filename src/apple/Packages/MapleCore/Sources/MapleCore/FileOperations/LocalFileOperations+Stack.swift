// LocalFileOperations+Stack.swift — the RAW+JPEG stack carried through relocate and trash (#5050).
// A stacked Library tile is the RAW; its same-stem JPEG follows it, so one action leaves neither
// file behind. The two share one XMP sidecar, which the shared-sidecar ownership rule
// (`SidecarOwnership`) already copies, never takes, until the last sibling leaves.

import Foundation

extension LocalFileOperations {

  /// Relocate `primaryURL` and its stacked JPEG together. Both are planned (copied and verified,
  /// nothing deleted) before either is finalized, so a JPEG that cannot follow leaves the RAW and
  /// everything else exactly where it was.
  static func relocateStack(
    _ primaryURL: URL, companion companionURL: URL, to destinationDir: URL,
    newBasename: String?, mode: RelocateMode, collision: CollisionPolicy
  ) async throws -> RelocateOutcome {
    let primaryPlan = try await planRelocate(
      primaryURL, to: destinationDir, newBasename: newBasename, mode: mode, collision: collision)
    let companionPlan: RelocatePlan
    do {
      companionPlan = try await planRelocate(
        companionURL, to: destinationDir,
        newBasename: companionBasename(
          companion: companionURL, primary: primaryURL,
          relocatedPrimaryPath: primaryPlan.finalPrimaryPath),
        mode: mode, collision: collision == .replace ? .replace : .fail,
        alsoLeaving: [primaryURL])
    } catch {
      await withdraw(primaryPlan, from: primaryURL)
      throw error
    }
    let primary = await finalizeRelocate(primaryPlan)
    let companion = await finalizeRelocate(companionPlan)
    return RelocateOutcome(
      primaryPath: primary.primaryPath, sidecarPath: primary.sidecarPath,
      renamedDueToCollision: primary.renamedDueToCollision,
      sidecarFollowed: primary.sidecarFollowed,
      companionPath: companion.primaryPath)
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
