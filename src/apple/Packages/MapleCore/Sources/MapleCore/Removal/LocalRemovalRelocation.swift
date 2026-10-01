// Locked source snapshots for local relocation (#3944). Companions are
// published before destination XMP; source deletion rechecks this snapshot.
import Darwin
import Foundation

public struct LocalRelocationSnapshot: Sendable, Equatable {
  public let sidecar: Data?
  public let originalDigest: String
  public let backups: [String: String]
  public let journalID: String?
  let lease: LocalRelocationLease?
}

final class LocalRemovalRelocation: Sendable {
  let records: String?
  let sourceSidecar: URL
  let snapshot: Data?
  let originalDigest: String
  private let descriptor: Int32
  let sourceRaw: URL

  private init(
    records: String?, sourceSidecar: URL, snapshot: Data?,
    originalDigest: String, descriptor: Int32, sourceRaw: URL
  ) {
    self.records = records
    self.sourceSidecar = sourceSidecar
    self.snapshot = snapshot
    self.originalDigest = originalDigest
    self.descriptor = descriptor
    self.sourceRaw = sourceRaw
  }

  deinit {
    if descriptor >= 0 {
      flock(descriptor, LOCK_UN)
      close(descriptor)
    }
  }

  static func sidecarBytes(_ url: URL) throws -> Data? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try Data(contentsOf: url)
  }

  static func open(rawURL: URL) throws -> LocalRemovalRelocation {
    let sidecar = SidecarPath.sidecarURL(for: rawURL)
    let lockURL = sidecar.deletingLastPathComponent().appendingPathComponent(
      ".\(sidecar.lastPathComponent).lock")
    let descriptor = Darwin.open(lockURL.path, O_CREAT | O_RDWR, 0o600)
    do {
      if descriptor >= 0 {
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { throw RemovalError.saveConflict }
      }
      if descriptor < 0,
        FileManager.default.fileExists(atPath: LocalRelocationJournal.url(for: rawURL).path)
      {
        throw RemovalError.invalid("Cannot lock this photo for relocation recovery")
      }
      try LocalRelocationJournal.recoverIfAbandoned(target: rawURL)
      // Snapshot all sidecars, including absence. Copying a live sidecar after
      // discovering no removals could otherwise publish a new edit without assets.
      let snapshot = try sidecarBytes(sidecar)
      let records = try snapshot.flatMap { try RemovalXMPRecords.read($0) }
      if let records, !(try RemovalBridge.assetNames(records: records)).isEmpty,
        descriptor < 0
      {
        throw RemovalError.invalid("Cannot lock the accepted removal sidecar for relocation")
      }
      let original = try RemovalBridge.digest(Data(contentsOf: rawURL, options: .mappedIfSafe))
      return LocalRemovalRelocation(
        records: records, sourceSidecar: sidecar,
        snapshot: snapshot, originalDigest: original,
        descriptor: descriptor, sourceRaw: rawURL)
    } catch {
      if descriptor >= 0 {
        flock(descriptor, LOCK_UN)
        close(descriptor)
      }
      throw error
    }
  }

  func copyCompanions(to rawURL: URL) async throws {
    try verifySnapshot()
    if let records {
      try await LocalRemovalAssetStore(rawURL: sourceRaw).copyAssets(records: records, to: rawURL)
    }
    try verifySnapshot()
  }

  func verifySnapshot() throws {
    guard try Self.sidecarBytes(sourceSidecar) == snapshot,
      try RemovalBridge.digest(Data(contentsOf: sourceRaw, options: .mappedIfSafe))
        == originalDigest
    else { throw RemovalError.saveConflict }
  }

  func verifyDestination(rawURL: URL) throws {
    guard
      try RemovalBridge.digest(Data(contentsOf: rawURL, options: .mappedIfSafe)) == originalDigest,
      try Self.sidecarBytes(SidecarPath.sidecarURL(for: rawURL)) == snapshot
    else { throw RemovalError.saveConflict }
    if let records { try RemovalBridge.verifySource(records: records, rawURL: rawURL) }
  }

  func proof(
    backups: [String: String], journalID: String? = nil,
    lease: LocalRelocationLease? = nil
  ) -> LocalRelocationSnapshot {
    LocalRelocationSnapshot(
      sidecar: snapshot, originalDigest: originalDigest, backups: backups,
      journalID: journalID, lease: lease)
  }
}
