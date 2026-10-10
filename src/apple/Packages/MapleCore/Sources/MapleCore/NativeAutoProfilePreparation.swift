// #1472: one native fit in flight, joined by same-source callers. Cancellation
// of one waiter must not cancel a fit still needed by another session.
import Foundation

actor NativeAutoProfilePreparation {
  static let shared = NativeAutoProfilePreparation()
  struct Key: Equatable, Sendable {
    let url: URL
    let modified: Date
    let created: Date?
    let size: UInt64
    let fileID: UInt64?
    let quality: Int32

    static func read(url: URL, quality: PipelineRenderer.Quality) throws -> Key {
      let canonical = url.resolvingSymlinksInPath().standardizedFileURL
      let attrs = try FileManager.default.attributesOfItem(atPath: canonical.path)
      guard let modified = attrs[.modificationDate] as? Date,
        let size = attrs[.size] as? NSNumber
      else { throw NativeAutoProfileError.sourceChanged }
      return Key(
        url: canonical, modified: modified, created: attrs[.creationDate] as? Date,
        size: size.uint64Value, fileID: (attrs[.systemFileNumber] as? NSNumber)?.uint64Value,
        quality: quality.rawValue)
    }
  }
  private struct Flight {
    let id: UUID
    let key: Key
    let flag: CancelFlag
    let task: Task<NativeAutoProfile, Error>
    var waiters: Set<UUID>
  }
  private var flight: Flight?
  private var ready: (Key, NativeAutoProfile)?  // Capacity one, including absent.

  func prepare(url: URL, scope: URL, quality: PipelineRenderer.Quality) async throws
    -> NativeAutoProfile
  {
    let accessing = scope.startAccessingSecurityScopedResource()
    defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
    try Task.checkCancellation()
    let key = try Key.read(url: url, quality: quality)
    // Different-key jobs wait for actual worker return, including cancellation.
    // No detached replacement can overlap the old multi-GB develop buffers.
    while let old = flight, old.key != key || old.waiters.isEmpty {
      let result = await old.task.result
      finish(id: old.id, result: result)
      try Task.checkCancellation()
    }
    try Task.checkCancellation()
    guard key == (try Key.read(url: url, quality: quality)) else {
      throw NativeAutoProfileError.sourceChanged
    }
    if let ready, ready.0 == key { return ready.1 }
    let waiter = UUID()
    let current: Flight
    if var old = flight {
      old.waiters.insert(waiter)
      flight = old
      current = old
    } else {
      let flag = CancelFlag()
      let task = Task {
        try await NativeAutoProfileWorker.shared.prepare(url: url, quality: quality, cancel: flag)
      }
      current = Flight(id: UUID(), key: key, flag: flag, task: task, waiters: [waiter])
      flight = current
    }
    let result = await withTaskCancellationHandler {
      await current.task.result
    } onCancel: {
      Task { await self.withdraw(id: current.id, waiter: waiter) }
    }
    finish(id: current.id, result: result)
    try Task.checkCancellation()
    guard key == (try Key.read(url: url, quality: quality)) else {
      if ready?.0 == key { ready = nil }
      throw NativeAutoProfileError.sourceChanged
    }
    return try result.get()
  }

  private func withdraw(id: UUID, waiter: UUID) {
    guard var old = flight, old.id == id else { return }
    old.waiters.remove(waiter)
    if old.waiters.isEmpty {
      old.flag.requestCancel()
      old.task.cancel()
    }
    flight = old
  }

  private func finish(id: UUID, result: Result<NativeAutoProfile, Error>) {
    guard let old = flight, old.id == id else { return }
    if !old.waiters.isEmpty, case .success(let result) = result {
      ready = (old.key, result)
    }
    flight = nil
  }

  func _testActiveWaiterCount() -> Int { flight?.waiters.count ?? 0 }

  func clearReady() { ready = nil }
}
