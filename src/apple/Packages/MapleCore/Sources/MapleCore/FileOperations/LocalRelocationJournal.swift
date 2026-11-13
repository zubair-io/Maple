// Durable replacement recovery (#3944). Recovery never unlinks a source.
// Journal and backup paths are confined to the destination directory.
import Foundation

struct RelocationJournalFile: Codable {
  let digest: String?
  let backup: String?
}

struct RelocationJournalRecord: Codable {
  let schema: Int
  let id: String
  let ownerPID: Int32
  let targetName: String
  let sourcePath: String
  let originalDigest: String
  let sidecarDigest: String?
  let sidecarData: Data?
  let previous: [String: RelocationJournalFile]
}

enum LocalRelocationJournal {
  static func url(for target: URL) -> URL {
    target.deletingLastPathComponent().appendingPathComponent(
      ".\(target.lastPathComponent).relocation.json")
  }

  static func digestIfPresent(_ url: URL) throws -> String? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try RemovalBridge.digest(Data(contentsOf: url, options: .mappedIfSafe))
  }

  static func create(
    source: LocalRemovalRelocation, target: URL,
    backups: [String: String]
  ) throws -> LocalRelocationLease {
    let lease = try LocalRelocationLease(target: target)
    let sidecar = SidecarPath.sidecarURL(for: target)
    let previous = try Dictionary(
      uniqueKeysWithValues: [target, sidecar].map { file in
        (
          file.lastPathComponent,
          RelocationJournalFile(
            digest: try digestIfPresent(file),
            backup: backups[file.path].map { URL(fileURLWithPath: $0).lastPathComponent })
        )
      })
    let id = lease.id
    let record = RelocationJournalRecord(
      schema: 1, id: id,
      ownerPID: ProcessInfo.processInfo.processIdentifier,
      targetName: target.lastPathComponent, sourcePath: source.sourceRaw.path,
      originalDigest: source.originalDigest,
      sidecarDigest: try source.snapshot.map { try RemovalBridge.digest($0) },
      sidecarData: source.snapshot, previous: previous)
    let destination = url(for: target)
    guard !FileManager.default.fileExists(atPath: destination.path) else {
      throw RemovalError.saveConflict
    }
    let temporary = URL(fileURLWithPath: destination.path + ".tmp." + id)
    defer { try? FileManager.default.removeItem(at: temporary) }
    try JSONEncoder().encode(record).write(to: temporary, options: .withoutOverwriting)
    let handle = try FileHandle(forWritingTo: temporary)
    defer { try? handle.close() }
    try handle.synchronize()
    try FileManager.default.moveItem(at: temporary, to: destination)
    try LocalFileOperations.synchronizeLocalDirectory(destination.deletingLastPathComponent())
    return lease
  }

  static func verifyOwner(_ id: String?, target: URL) throws {
    guard let id else { return }
    let record = try read(target: target)
    guard record.id == id else { throw RemovalError.saveConflict }
  }

  static func remove(_ id: String?, target: URL) throws {
    guard id != nil else { return }
    try verifyOwner(id, target: target)
    try FileManager.default.removeItem(at: url(for: target))
    try LocalFileOperations.synchronizeLocalDirectory(target.deletingLastPathComponent())
  }

  static func read(target: URL) throws -> RelocationJournalRecord {
    let record = try JSONDecoder().decode(
      RelocationJournalRecord.self,
      from: Data(contentsOf: url(for: target)))
    let sidecar = SidecarPath.sidecarURL(for: target)
    guard record.schema == 1, UUID(uuidString: record.id) != nil,
      record.ownerPID > 0,
      record.targetName == target.lastPathComponent,
      Set(record.previous.keys) == Set([target.lastPathComponent, sidecar.lastPathComponent])
    else {
      throw RemovalError.invalid("Unrecognized relocation recovery journal")
    }
    guard try record.sidecarData.map({ try RemovalBridge.digest($0) }) == record.sidecarDigest
    else {
      throw RemovalError.invalid("Relocation sidecar snapshot content differs from its digest")
    }
    for (name, previous) in record.previous {
      if let backup = previous.backup {
        guard previous.digest != nil, FilenameValidation.isValidPathComponent(backup),
          backup.hasPrefix(name + ".tmp."), backup.hasSuffix(".rollback")
        else {
          throw RemovalError.invalid("Relocation backup escapes its destination")
        }
      } else if previous.digest != nil {
        throw RemovalError.invalid("Relocation recovery backup is missing")
      }
    }
    return record
  }

  /// Caller holds the destination XMP lock. A live owner keeps its plan/undo
  /// rights. An abandoned complete pair is retained; a partial pair is rolled
  /// back only if all present bytes belong to the recorded old/new states.
  static func recoverIfAbandoned(target: URL) throws {
    guard FileManager.default.fileExists(atPath: url(for: target).path) else { return }
    let record = try read(target: target)
    let lease = try LocalRelocationLease(target: target)
    defer { lease.release() }
    let sidecar = SidecarPath.sidecarURL(for: target)
    let primaryDigest = try digestIfPresent(target)
    let sidecarDigest = try digestIfPresent(sidecar)
    let complete = primaryDigest == record.originalDigest && sidecarDigest == record.sidecarDigest
    let previousComplete =
      primaryDigest == record.previous[target.lastPathComponent]!.digest
      && sidecarDigest == record.previous[sidecar.lastPathComponent]!.digest
    if complete {
      if let data = try LocalRemovalRelocation.sidecarBytes(sidecar),
        let records = try RemovalXMPRecords.read(data)
      {
        try RemovalBridge.verifySource(records: records, rawURL: target)
        _ = try LocalRemovalAssetStore.readAssets(
          records: records,
          directory: target.deletingLastPathComponent().appendingPathComponent(".maple/inpaint"))
      }
    } else if !previousComplete {
      // A source may have been moved/deleted independently after the crash.
      // Never replace/unlink the only remaining copy of the incoming edit.
      let source = URL(fileURLWithPath: record.sourcePath)
      let sourceLock = try LocalFileOperations.lockRelocationDestination(
        source, sourceSidecar: sidecar)
      defer { LocalFileOperations.unlockRelocationDestination(sourceLock) }
      guard source.resolvingSymlinksInPath() != target.resolvingSymlinksInPath(),
        try digestIfPresent(source) == record.originalDigest,
        try digestIfPresent(SidecarPath.sidecarURL(for: source)) == record.sidecarDigest
      else {
        throw RemovalError.invalid(
          "Recovery must retain the incoming edit until its original source is available")
      }
      if let data = try LocalRemovalRelocation.sidecarBytes(SidecarPath.sidecarURL(for: source)),
        let records = try RemovalXMPRecords.read(data)
      {
        try RemovalBridge.verifySource(records: records, rawURL: source)
        _ = try LocalRemovalAssetStore.readAssets(
          records: records,
          directory: source.deletingLastPathComponent().appendingPathComponent(".maple/inpaint"))
      }
      let files = [target, sidecar]
      // Validate the entire current pair and backups before changing either.
      for file in files {
        let previous = record.previous[file.lastPathComponent]!
        let current = try digestIfPresent(file)
        let incoming = file == target ? record.originalDigest : record.sidecarDigest
        guard current == previous.digest || current == incoming || current == nil else {
          throw RemovalError.saveConflict
        }
        if let backup = previous.backup {
          let backupURL = file.deletingLastPathComponent().appendingPathComponent(backup)
          guard try digestIfPresent(backupURL) == previous.digest else {
            throw RemovalError.invalid("Relocation backup content is missing or changed")
          }
        }
      }
      if primaryDigest == record.originalDigest,
        primaryDigest != record.previous[target.lastPathComponent]!.digest
      {
        try preserveIncoming(record, target: target)
      }
      for file in files {
        let previous = record.previous[file.lastPathComponent]!
        if let backup = previous.backup {
          try LocalFileOperations.copyVerified(
            from: file.deletingLastPathComponent().appendingPathComponent(backup), to: file)
        } else if FileManager.default.fileExists(atPath: file.path) {
          try FileManager.default.removeItem(at: file)
        }
      }
      try LocalFileOperations.synchronizeLocalDirectory(target.deletingLastPathComponent())
    }
    // Cleanup itself is restartable. Missing backups may already have been
    // removed after a complete pair; changed backup bytes belong to a later writer.
    for previous in record.previous.values {
      if let backup = previous.backup {
        let backupURL = target.deletingLastPathComponent().appendingPathComponent(backup)
        if FileManager.default.fileExists(atPath: backupURL.path),
          try digestIfPresent(backupURL) != previous.digest
        {
          throw RemovalError.saveConflict
        }
      }
    }
    for previous in record.previous.values {
      if let backup = previous.backup {
        let backupURL = target.deletingLastPathComponent().appendingPathComponent(backup)
        if FileManager.default.fileExists(atPath: backupURL.path) {
          try FileManager.default.removeItem(at: backupURL)
        }
      }
    }
    try remove(record.id, target: target)
  }
  static func incomingURL(_ record: RelocationJournalRecord, target: URL) -> URL {
    URL(fileURLWithPath: target.path + ".tmp." + record.id + ".incoming")
  }

  private static func preserveIncoming(_ record: RelocationJournalRecord, target: URL) throws {
    // Keep an independently durable copy before replacing the incoming RAW.
    // Even an external source unlink cannot make rollback discard its last bytes.
    let incoming = incomingURL(record, target: target)
    if FileManager.default.fileExists(atPath: incoming.path) {
      guard try digestIfPresent(incoming) == record.originalDigest else {
        throw RemovalError.saveConflict
      }
    } else {
      try LocalFileOperations.copyVerified(from: target, to: incoming)
    }
    let sidecar = SidecarPath.sidecarURL(for: incoming)
    if FileManager.default.fileExists(atPath: sidecar.path) {
      guard try digestIfPresent(sidecar) == record.sidecarDigest else {
        throw RemovalError.saveConflict
      }
    } else if let data = record.sidecarData {
      try data.write(to: sidecar, options: .withoutOverwriting)
      let handle = try FileHandle(forWritingTo: sidecar)
      defer { try? handle.close() }
      try handle.synchronize()
    }
    try LocalFileOperations.synchronizeLocalDirectory(target.deletingLastPathComponent())
  }

}
