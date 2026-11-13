// SMBFileOperations+SameFile.swift — the same-file / case-only-rename guard
// for the SMB relocate primitive, split out of SMBFileOperations.swift to
// keep it under the file-size headroom (the local twin lives in
// LocalFileOperations+SameFile.swift).

import Foundation
import OSLog

private let sameFileLog = Logger(subsystem: "app.justmaple.aperture", category: "SMBFileOperations")

extension SMBFileOperations {

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
  /// NOT detected here. Nor does the transport report whether the share
  /// folds case, so a case-only difference is classified as a rename on
  /// every share; `performCaseOnlyRename` resolves the sidecar by file
  /// identity instead.
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
  ///
  /// On a share that does not fold case the target sidecar spelling names a
  /// second file, so the sidecar follows the shared-sidecar rule (#4707):
  /// an occupied destination sidecar is a collision for the whole photo, a
  /// sidecar a same-stem sibling still reads is copied, and only an
  /// unshared one is moved. Every decision is taken before the primary moves.
  static func performCaseOnlyRename(
    source: String, target: String, transport: SMBFileTransport
  ) async throws -> RelocatePlan {
    let sourceSidecarPath = sidecarPath(for: source)
    let targetSidecarPath = sidecarPath(for: target)
    let hadSidecar = await exists(sourceSidecarPath, transport: transport)
    let sameFile =
      hadSidecar
      ? await SidecarOwnership.sameSMBFile(sourceSidecarPath, targetSidecarPath, transport: transport)
      : false
    if !sameFile, await exists(targetSidecarPath, transport: transport) {
      throw FileOperationError.destinationExists(targetSidecarPath)
    }
    let claimed =
      hadSidecar && !sameFile
      ? await SidecarOwnership.smbStemClaimedBySibling(
        source, excluding: [target], transport: transport)
      : false

    try await transport.moveItem(atPath: source, toPath: target)

    let finalSidecarPath =
      hadSidecar
      ? await followCaseOnlySidecar(
        from: sourceSidecarPath, to: targetSidecarPath, copying: claimed, transport: transport)
      : nil

    // Inline cache cleanup, matching `LocalFileOperations`' identical
    // choice: `finalize` is a no-op for this plan (`isNoop`), and the
    // old-cased basename is a different hash input / preview filename,
    // so its entries are exactly as stale as after a real move.
    await invalidateDerivedCaches(forOldPrimaryPath: source, transport: transport)
    return RelocatePlan(
      mode: .move, sourcePrimaryPath: source, sourceSidecarPath: hadSidecar ? sourceSidecarPath : nil,
      finalPrimaryPath: target, finalSidecarPath: finalSidecarPath,
      renamedDueToCollision: false, createdPaths: [], sourceAlreadyRelocated: true)
  }

  /// Best-effort, matching the local engine's "primary renamed, sidecar left
  /// in place" contract: the primary rename is already complete and atomic,
  /// so a sidecar failure is logged rather than unwound.
  private static func followCaseOnlySidecar(
    from source: String, to target: String, copying: Bool, transport: SMBFileTransport
  ) async -> String? {
    do {
      if copying {
        try await copyVerified(from: source, to: target, transport: transport)
      } else {
        try await transport.moveItem(atPath: source, toPath: target)
      }
    } catch {
      sameFileLog.error(
        "performCaseOnlyRename: sidecar follow failed (\(source, privacy: .public)): \(error.localizedDescription, privacy: .public)"
      )
    }
    return await exists(target, transport: transport) ? target : nil
  }
}
