// macOS Trash carries an accepted removal as one recovery folder (#3944).
// Restoring or copying that folder retains RAW, XMP and durable companions.
import Darwin
import Foundation

struct RemovalTrashManifest: Codable {
  let schema: Int
  let originalPath: String
  let primaryName: String
  let originalDigest: String
  let sidecarDigest: String
}

extension LocalFileOperations {
  static func prepareRemovalTrashPackage(
    _ source: LocalRemovalRelocation, raw: URL,
    directory: URL
  ) async throws -> RelocatePlan {
    guard let records = source.records,
      !(try RemovalBridge.assetNames(records: records)).isEmpty,
      let snapshot = source.snapshot
    else {
      throw RemovalError.invalid("Recovery folder requires an accepted removal sidecar")
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let target = directory.appendingPathComponent(raw.lastPathComponent)
    let plan = try await placeLocalSnapshot(
      source, from: raw, to: target, mode: .move, renamed: false)
    do {
      let manifest = RemovalTrashManifest(
        schema: 1, originalPath: raw.path,
        primaryName: raw.lastPathComponent,
        originalDigest: source.originalDigest, sidecarDigest: try RemovalBridge.digest(snapshot))
      let data = try JSONEncoder().encode(manifest)
      let url = directory.appendingPathComponent("Maple Recovery.json")
      try data.write(to: url, options: .withoutOverwriting)
      let handle = try FileHandle(forWritingTo: url)
      defer { try? handle.close() }
      try handle.synchronize()
      let descriptor = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY)
      guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
      defer { close(descriptor) }
      guard fsync(descriptor) == 0 else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
      }
      return plan
    } catch {
      revertPlan(plan)
      throw error
    }
  }

  /// Recover the whole edit to its recorded folder, restricted to the
  /// supplied library root. Finder can also recover the entire folder.
  public static func restoreRemovalTrashPackage(
    _ directory: URL,
    libraryRoot: URL
  ) async throws -> RelocateOutcome {
    let manifest = try JSONDecoder().decode(
      RemovalTrashManifest.self,
      from: Data(contentsOf: directory.appendingPathComponent("Maple Recovery.json")))
    guard manifest.schema == 1, FilenameValidation.isValidPathComponent(manifest.primaryName) else {
      throw FileOperationError.invalidDestination("Unsupported removal recovery folder")
    }
    let original = URL(fileURLWithPath: manifest.originalPath)
    let destination = original.deletingLastPathComponent().resolvingSymlinksInPath()
    let root = libraryRoot.resolvingSymlinksInPath()
    guard destination.path == root.path || destination.path.hasPrefix(root.path + "/"),
      original.lastPathComponent == manifest.primaryName
    else {
      throw FileOperationError.invalidDestination("Recovery destination is outside this library")
    }
    let raw = directory.appendingPathComponent(manifest.primaryName)
    guard
      try RemovalBridge.digest(Data(contentsOf: raw, options: .mappedIfSafe))
        == manifest.originalDigest
    else {
      throw RemovalError.invalid("Recovery original differs from its manifest")
    }
    let sidecar = try Data(contentsOf: SidecarPath.sidecarURL(for: raw))
    guard try RemovalBridge.digest(sidecar) == manifest.sidecarDigest,
      let records = try RemovalXMPRecords.read(sidecar),
      !(try RemovalBridge.assetNames(records: records)).isEmpty
    else {
      throw RemovalError.invalid("Recovery removal sidecar differs from its manifest")
    }
    return try await relocate(raw, to: destination, mode: .move, collision: .autoSuffix)
  }

  #if os(macOS)
    static func trashAcceptedRemoval(
      _ source: LocalRemovalRelocation,
      raw: URL
    ) async throws -> RelocateOutcome {
      let fm = FileManager.default
      let staging = raw.deletingLastPathComponent().appendingPathComponent(".maple/trash-staging")
      let folder = staging.appendingPathComponent(
        String(raw.lastPathComponent.prefix(40)) + " Recovery " + UUID().uuidString)
      let plan = try await prepareRemovalTrashPackage(source, raw: raw, directory: folder)
      var result: NSURL?
      do {
        try source.verifySnapshot()
        try fm.trashItem(at: folder, resultingItemURL: &result)
      } catch {
        revertPlan(plan)
        throw error
      }
      guard let trashed = result as URL? else {
        // Original remains intact if the OS cannot tell us where the verified
        // recovery folder landed. Never guess a Trash path and unlink source.
        throw FileOperationError.verificationFailed(
          "OS Trash did not return the removal recovery folder")
      }
      let target = trashed.appendingPathComponent(raw.lastPathComponent)
      try source.verifySnapshot()
      try source.verifyDestination(rawURL: target)
      let moved = RelocatePlan(
        mode: .move, sourcePrimaryPath: raw.path,
        sourceSidecarPath: source.sourceSidecar.path,
        finalPrimaryPath: target.path,
        finalSidecarPath: SidecarPath.sidecarURL(for: target).path,
        renamedDueToCollision: false, createdPaths: [target.path])
      try removeSnapshotSources(moved)
      await invalidateDerivedCaches(forOldPrimaryPath: raw.path)
      await refreshLibraryIndexAfterMove(moved)
      return RelocateOutcome(
        primaryPath: target.path, sidecarPath: moved.finalSidecarPath,
        renamedDueToCollision: false, sidecarFollowed: true)
    }
  #endif
}
