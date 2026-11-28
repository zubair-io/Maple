// A photo's conflict copies travel with it through SMB relocate and trash (#6134) under the
// canonical sidecar's rules (docs/xmp-canonical-format.md § "Moving, renaming and trashing a
// photo"). Each folder is listed once per plan: a share round trip per candidate name would make
// Auto-suffix cost a listing per probe.

import Foundation
import OSLog

private let conflictCopyLog = Logger(
  subsystem: "app.justmaple.aperture", category: "SMBFileOperations")

typealias SMBConflictCopyMove = (source: String, destination: String)

/// The two folders one relocate reads, listed once. A folder that exists but cannot be listed stops
/// the operation: guessing that nothing is there would leave a conflict copy behind or publish
/// one over another photo's sidecar. A folder that is genuinely not found (a first trash) is empty.
struct SMBFolderScan: Sendable {
  let sourcePrimaryPath: String
  let sourceNames: [String]
  let destinationNames: [String]

  static func load(
    sourcePrimaryPath: String, destinationDirectory: String, transport: SMBFileTransport
  ) async throws -> SMBFolderScan {
    let sourceDirectory = (sourcePrimaryPath as NSString).deletingLastPathComponent
    let sourceNames = try await list(sourceDirectory, transport: transport)
    let destinationNames =
      try await sourceDirectory == destinationDirectory
      ? sourceNames : list(destinationDirectory, transport: transport)
    return SMBFolderScan(
      sourcePrimaryPath: sourcePrimaryPath, sourceNames: sourceNames,
      destinationNames: destinationNames)
  }

  private static func list(_ directory: String, transport: SMBFileTransport) async throws
    -> [String]
  {
    do {
      return try await SidecarOwnership.smbFileNames(inDirectory: directory, transport: transport)
    } catch {
      guard try await isMissing(directory, transport: transport) else {
        throw FileOperationError.underlying(
          "cannot list \(directory): \(error.localizedDescription)")
      }
      return []
    }
  }

  /// Only a genuine not-found makes a folder empty: a share that drops the attribute read too
  /// must stop the move, not read as an unclaimed folder.
  private static func isMissing(_ directory: String, transport: SMBFileTransport) async throws
    -> Bool
  {
    do {
      _ = try await transport.attributesOfItem(atPath: directory)
      return false
    } catch let error as POSIXError where error.code == .ENOENT {
      return true
    } catch {
      throw FileOperationError.underlying(
        "cannot read \(directory): \(error.localizedDescription)")
    }
  }

  /// Every conflict copy beside the source photo, with the name it takes once the photo is
  /// `targetPath`.
  func conflictCopyMoves(to targetPath: String) throws -> [SMBConflictCopyMove] {
    let directory = (sourcePrimaryPath as NSString).deletingLastPathComponent
    return try ConflictCopyPairing.names(
      in: sourceNames, primaryName: (sourcePrimaryPath as NSString).lastPathComponent,
      foldsCase: true
    ).map { name in
      let source = SMBFileOperations.posixJoin(directory, name)
      let destination = try RestoreSidecarPairing.target(
        source, from: sourcePrimaryPath, to: targetPath)
      return (source, destination)
    }
  }

  /// True when the destination holds a conflict copy at the photo's new stem that is not this
  /// photo's own (or byte-identical to it), or a copy would land on another photo's sidecar name.
  func conflictCopiesBlocked(at targetPath: String, transport: SMBFileTransport) async -> Bool {
    guard let moves = try? conflictCopyMoves(to: targetPath) else { return true }
    let directory = (targetPath as NSString).deletingLastPathComponent
    let targetName = (targetPath as NSString).lastPathComponent
    let occupants = ConflictCopyPairing.names(
      in: destinationNames, primaryName: targetName, foldsCase: true)
    let heldByOther = await occupants.asyncContains { name in
      let occupant = SMBFileOperations.posixJoin(directory, name)
      let candidates = moves.filter { $0.destination.lowercased() == occupant.lowercased() }
      return await !candidates.asyncContains { move in
        if await SidecarOwnership.sameSMBFile(move.source, occupant, transport: transport) {
          return true
        }
        return await SidecarOwnership.smbSidecarAlreadyCarried(
          move.source, at: occupant, transport: transport)
      }
    }
    return heldByOther
      || moves.contains {
        ConflictCopyPairing.isSidecarOfAnotherPhoto(
          ($0.destination as NSString).lastPathComponent, among: destinationNames,
          besides: targetName, foldsCase: true)
      }
  }

  struct ConflictCopyPlan {
    /// Copies that go with the photo and leave the source once it has moved.
    let carried: [SMBConflictCopyMove]
    /// The part of `carried` the destination does not already hold byte for byte.
    let toCopy: [SMBConflictCopyMove]
  }

  func conflictCopyPlan(to targetPath: String, transport: SMBFileTransport) async throws
    -> ConflictCopyPlan
  {
    guard await !conflictCopiesBlocked(at: targetPath, transport: transport) else {
      throw FileOperationError.destinationExists(targetPath)
    }
    let moves = try conflictCopyMoves(to: targetPath)
    let carried = await moves.asyncFilter {
      await !SidecarOwnership.sameSMBFile($0.source, $0.destination, transport: transport)
    }
    let toCopy = await carried.asyncFilter {
      await !SidecarOwnership.smbSidecarAlreadyCarried(
        $0.source, at: $0.destination, transport: transport)
    }
    return ConflictCopyPlan(carried: carried, toCopy: toCopy)
  }
}

extension SMBFileOperations {

  static func stageConflictCopies(
    _ copies: [SMBConflictCopyMove], removingOnFailure: [String], transport: SMBFileTransport
  ) async throws -> [(temp: String, destination: String)] {
    var staged: [(temp: String, destination: String)] = []
    do {
      for copy in copies {
        let temp = try await stageVerifiedCopy(
          from: copy.source, to: copy.destination, transport: transport)
        staged.append((temp, copy.destination))
      }
    } catch {
      await discardAll(removingOnFailure + staged.map(\.temp), transport: transport)
      throw error
    }
    return staged
  }

  /// Published under exclusive names: one taken meanwhile is a collision for the whole photo.
  static func publishConflictCopies(
    _ staged: [(temp: String, destination: String)], removingOnFailure: [String],
    transport: SMBFileTransport
  ) async throws -> [String] {
    var published: [String] = []
    do {
      for item in staged {
        _ = try await stagePublish(
          item.temp, to: item.destination, allowReplace: false, transport: transport)
        published.append(item.destination)
      }
    } catch {
      await discardAll(published + staged.map(\.temp) + removingOnFailure, transport: transport)
      throw (error as? FileOperationError)
        ?? .underlying("conflict copy publish failed: \(error.localizedDescription)")
    }
    return published
  }

  static func conflictCopyPaths(of primaryPath: String, transport: SMBFileTransport) async throws
    -> [String]
  {
    let directory = (primaryPath as NSString).deletingLastPathComponent
    return ConflictCopyPairing.names(
      in: try await SidecarOwnership.smbSiblingNames(of: primaryPath, transport: transport),
      primaryName: posixLastComponent(primaryPath), foldsCase: true
    ).map { posixJoin(directory, $0) }
  }

  /// A save that landed on a source copy since planning is not in the destination, so it stays.
  static func removeCarriedConflictCopies(_ plan: RelocatePlan, transport: SMBFileTransport) async {
    for (source, destination) in zip(plan.sourceVariantPaths, plan.finalVariantPaths) {
      guard
        await SidecarOwnership.smbSidecarAlreadyCarried(
          source, at: destination, transport: transport)
      else {
        conflictCopyLog.error("finalizeRelocate: changed conflict copy kept at source")
        continue
      }
      try? await transport.removeItem(atPath: source)
    }
  }

  static func discardAll(_ paths: [String], transport: SMBFileTransport) async {
    for path in paths { try? await transport.removeItem(atPath: path) }
  }
}

extension Sequence {
  fileprivate func asyncFilter(_ keep: (Element) async -> Bool) async -> [Element] {
    var kept: [Element] = []
    for element in self {
      if await keep(element) { kept.append(element) }
    }
    return kept
  }

  fileprivate func asyncContains(_ matches: (Element) async -> Bool) async -> Bool {
    for element in self {
      if await matches(element) { return true }
    }
    return false
  }
}
