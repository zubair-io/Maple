import Darwin
import Foundation

/// One macOS native bake at a time, with explicit durable restart recovery (#4113).
public actor NativeExportQueue {
  public static let shared = NativeExportQueue()
  public nonisolated let directory: URL
  private var record: NativeExportRecord?
  private var running = false
  private var cancellation = NativeExportCancellation()
  private var observers: [UUID: AsyncStream<NativeExportRecord?>.Continuation] = [:]

  private let checkpoint: (@Sendable (NativeExportRecord) async -> Void)?

  public init(directory: URL? = nil) {
    self.directory = directory ?? NativeExportStorage.root()
    self.checkpoint = nil
  }
  // Release-available fence for deterministic cancellation/process recovery tests (#4113).
  init(directory: URL, checkpoint: @escaping @Sendable (NativeExportRecord) async -> Void) {
    self.directory = directory
    self.checkpoint = checkpoint
  }
  private func didPersist() async {
    if let record, let checkpoint { await checkpoint(record) }
  }
  private var ledger: URL { directory.appendingPathComponent("queue.json") }

  public func load() async throws -> NativeExportRecord? {
    guard !running else { return record }
    let lock = try NativeExportRunLock(directory: directory)
    defer { withExtendedLifetime(lock) {} }
    return try await loadRecord()
  }

  private func loadRecord() async throws -> NativeExportRecord? {
    guard FileManager.default.fileExists(atPath: ledger.path) else {
      record = nil
      return nil
    }
    var loaded = try JSONDecoder().decode(NativeExportRecord.self, from: Data(contentsOf: ledger))
    try loaded.validate()
    if loaded.phase == "running" { loaded.phase = "interrupted" }
    record = loaded
    try await retireArtifacts()
    return record
  }
  public func updates() -> AsyncStream<NativeExportRecord?> {
    let id = UUID()
    return AsyncStream { continuation in
      observers[id] = continuation
      continuation.yield(record)
      continuation.onTermination = { [weak self] _ in Task { await self?.removeObserver(id) } }
    }
  }
  private func removeObserver(_ id: UUID) { observers.removeValue(forKey: id) }
  private func persist() throws {
    guard let record else { return }
    try NativeExportStorage.write(record, to: ledger)
    for observer in observers.values { observer.yield(record) }
  }

  public func enqueue(_ value: NativeExportRecord) async throws {
    guard !running else {
      throw NativeExportError.message("Wait for the active export to stop.")
    }
    let lock = try NativeExportRunLock(directory: directory)
    defer { withExtendedLifetime(lock) {} }
    let previous = try await loadRecord()
    guard previous?.remaining ?? 0 == 0 else {
      throw NativeExportError.message("Resume or cancel the saved export before starting another.")
    }
    try value.validate()
    var replacement = value
    let candidates = (previous?.retiredJobs ?? []) + [previous?.ownedJob].compactMap { $0 }
    replacement.retiredJobs = candidates.filter {
      !NativeExportArtifacts.referenced($0, by: replacement, workspace: directory)
    }
    record = replacement
    do { try persist() } catch {
      record = previous
      throw error
    }
    await didPersist()  // New references and retirement proofs are durable before deletion.
    try await retireArtifacts()
  }

  private func retireArtifacts() async throws {
    guard let current = record, let jobs = current.retiredJobs, !jobs.isEmpty else { return }
    for job in jobs {
      guard !NativeExportArtifacts.referenced(job, by: current, workspace: directory) else {
        continue
      }
      if let claimed = try NativeExportArtifacts.claim(job, workspace: directory) {
        await didPersist()  // Genuine crash/namespace substitution fence after exclusive custody.
        try await BlockingWork.run { try NativeExportArtifacts.removeClaimed(job, root: claimed) }
      }
    }
    record!.retiredJobs = nil
    try persist()
  }
  public func cancel() async throws {
    let lock = running ? nil : try NativeExportRunLock(directory: directory)
    defer { withExtendedLifetime(lock) {} }
    if !running { _ = try await loadRecord() }
    guard record != nil else { return }
    cancellation.cancel()
    record!.cancelRequested = true
    if !running { record!.phase = "cancelled" }
    try persist()
  }
  public func retryFailed() async throws {
    guard !running else { throw NativeExportError.message("Wait for the active export to stop.") }
    let lock = try NativeExportRunLock(directory: directory)
    defer { withExtendedLifetime(lock) {} }
    guard let previous = try await loadRecord(), previous.remaining == 0 else {
      throw NativeExportError.message("Wait for the export to stop before retrying failures.")
    }
    let failed = previous.items.filter { $0.status == "failed" }.map {
      NativeExportItem(target: $0.target)
    }
    guard !failed.isEmpty else {
      throw NativeExportError.message("This export has no failures to retry.")
    }
    record = NativeExportRecord(
      version: 1, id: UUID(), recipe: previous.recipe,
      destinationBookmark: previous.destinationBookmark, originals: previous.originals,
      filmDirectory: previous.filmDirectory, filmHashes: previous.filmHashes, items: failed,
      ownedJob: previous.ownedJob, retiredJobs: previous.retiredJobs)
    try persist()
  }

  /// Preserve unreadable/legacy private queue bytes while allowing a new safe capture.
  public func archiveSavedQueue() throws -> URL? {
    guard !running else {
      throw NativeExportError.message(
        "Cancel and wait for the active export before archiving its queue.")
    }
    let lock = try NativeExportRunLock(directory: directory)
    defer { withExtendedLifetime(lock) {} }
    guard FileManager.default.fileExists(atPath: ledger.path) else { return nil }
    let rejected = directory.appendingPathComponent("Rejected", isDirectory: true)
    try FileManager.default.createDirectory(at: rejected, withIntermediateDirectories: true)
    let archived = rejected.appendingPathComponent(UUID().uuidString + ".json")
    guard !FileManager.default.fileExists(atPath: archived.path) else {
      throw NativeExportError.message("The rejected-queue archive already exists. Try again.")
    }
    try FileManager.default.moveItem(at: ledger, to: archived)
    try NativeExportStorage.syncDirectory(rejected)
    try NativeExportStorage.syncDirectory(directory)
    record = nil
    for observer in observers.values { observer.yield(nil) }
    return archived
  }

  public func discardRemaining() async throws {
    guard !running else {
      throw NativeExportError.message(
        "Cancel and wait for the active export before discarding remaining work.")
    }
    let lock = try NativeExportRunLock(directory: directory)
    defer { withExtendedLifetime(lock) {} }
    guard var value = try await loadRecord() else { return }
    for index in value.items.indices
    where !["applied", "failed", "skipped"].contains(value.items[index].status) {
      value.items[index].status = "skipped"
      value.items[index].reason = "Discarded by user; no output was published."
    }
    value.phase = "done"
    record = value
    try persist()
  }

  public func authorizeDestination(_ url: URL) async throws {
    guard !running else {
      throw NativeExportError.message("Stop this export before changing its grant.")
    }
    let lock = try NativeExportRunLock(directory: directory)
    defer { withExtendedLifetime(lock) {} }
    guard var value = try await loadRecord() else { return }
    value.destinationBookmark = try NativeExportAccess.bookmark(url)
    record = value
    try persist()
  }

  public func authorizeSource(id: String, url: URL) async throws {
    guard !running else {
      throw NativeExportError.message("Stop this export before changing its grant.")
    }
    let lock = try NativeExportRunLock(directory: directory)
    defer { withExtendedLifetime(lock) {} }
    guard var value = try await loadRecord(),
      let index = value.originals.firstIndex(where: { $0.id == id })
    else {
      throw NativeExportError.message("This original is not part of the saved selection.")
    }
    let granted = url.startAccessingSecurityScopedResource()
    defer { if granted { url.stopAccessingSecurityScopedResource() } }
    guard try NativeExportStorage.hash(url) == value.originals[index].originalHash else {
      throw NativeExportError.message(
        "Choose the unchanged original photo. Its bytes must match the captured export.")
    }
    var source = value.originals[index]
    source.scopeURL = url
    source.relativePath = ""
    source.bookmark = try NativeExportAccess.bookmark(url)
    value.originals[index] = source
    value.items = value.items.map { item in
      guard item.id == id else { return item }
      let target = NativeExportTarget(
        source: source, stem: item.target.stem, xmp: item.target.xmp,
        capturedAt: item.target.capturedAt, index: item.target.index)
      return NativeExportItem(
        target: target, status: item.status, reason: item.reason,
        output: item.output, staging: item.staging, beforeHash: item.beforeHash,
        afterHash: item.afterHash, stagingIdentity: item.stagingIdentity)
    }
    record = value
    try persist()
  }

  public func run() async throws {
    guard !running else { return }
    let lock = try NativeExportRunLock(directory: directory)
    guard let loaded = try await loadRecord() else { return }
    try loaded.validate()
    running = true
    cancellation = NativeExportCancellation()
    record!.cancelRequested = false
    record!.phase = "running"
    defer {
      running = false
      withExtendedLifetime(lock) {}
    }
    try persist()
    await didPersist()
    let access: NativeExportAccess
    do {
      access = try await BlockingWork.run {
        try NativeExportAccess(record: loaded, workspace: self.directory)
      }
    } catch {
      record!.phase = "interrupted"
      try persist()
      await didPersist()
      throw error
    }
    for index in loaded.items.indices {
      if record!.cancelRequested {
        record!.phase = "cancelled"
        try persist()
        await didPersist()
        return
      }
      if ["applied", "failed", "skipped"].contains(record!.items[index].status) { continue }
      do {
        let current = record!
        let entry = current.items[index]
        let prepared = try await BlockingWork.run {
          try NativeExportPublication.prepare(entry, record: current, access: access)
        }
        record!.items[index] = prepared
        try persist()
        await didPersist()  // Durable rendering identity precedes the native create_new write.
        if prepared.status == "rendering" {
          let snapshot = record!
          record!.items[index] = try await BlockingWork.run {
            try NativeExportPublication.render(prepared, record: snapshot, access: access)
          }
          try persist()
          await didPersist()  // Prepared bytes/hash are durable before any publication.
        }
        if record!.cancelRequested {
          let pending = record!.items[index]
          if let staging = pending.staging {
            let snapshot = record!
            try await BlockingWork.run {
              try NativeExportPublication.staging(pending, record: snapshot, access: access)
              guard try NativeExportStorage.hash(staging) == pending.afterHash else {
                throw NativeExportError.message(
                  "Staging changed before cancellation cleanup. Its bytes were preserved for review."
                )
              }
              try FileManager.default.removeItem(at: staging)
            }
          }
          record!.items[index] = NativeExportItem(target: pending.target)
          record!.phase = "cancelled"
          try persist()
          await didPersist()
          return
        }
        if record!.items[index].status == "prepared" {
          let snapshot = record!
          let item = snapshot.items[index]
          let control = cancellation
          let published = try await BlockingWork.run {
            try NativeExportPublication.publish(
              item, record: snapshot, access: access, cancellation: control)
          }
          // Durable output exists, but the on-disk ledger still says prepared.
          // The same release-available fence proves genuine crash/lost-ack recovery.
          if let checkpoint {
            var notice = snapshot
            notice.items[index] = published
            await checkpoint(notice)
          }
          record!.items[index] = published
          try persist()
          await didPersist()
        }
      } catch let error as NativeExportPublicationDurabilityError {
        record!.phase = "interrupted"
        try persist()
        await didPersist()
        throw error
      } catch is CancellationError {
        record!.phase = "cancelled"
        try persist()
        await didPersist()
        return
      } catch {
        record!.items[index].status = "failed"
        record!.items[index].reason = NativeExportStorage.failure(error)
        try persist()
        await didPersist()
      }
    }
    record!.phase = record!.cancelRequested ? "cancelled" : "done"
    try persist()
    await didPersist()
  }
}

/// A file lock is released by the OS after a genuine process crash/relaunch.
private final class NativeExportRunLock {
  private let descriptor: Int32
  init(directory: URL) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    descriptor = Darwin.open(
      directory.appendingPathComponent("active.lock").path, O_CREAT | O_RDWR, 0o600)
    guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      Darwin.close(descriptor)
      throw NativeExportError.message("Another Maple process is exporting. Wait for it to finish.")
    }
  }
  deinit {
    flock(descriptor, LOCK_UN)
    Darwin.close(descriptor)
  }
}

final class NativeExportCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
  }
  func publish<T>(_ work: () throws -> T) throws -> T {
    lock.lock()
    defer { lock.unlock() }
    guard !cancelled else { throw CancellationError() }
    return try work()
  }
}
