// Sources/MapleBackup/BackupQueue.swift
//
// Priority-ordered backup task queue with observable event stream.
// Decouples the BackupEngine from the worker infrastructure — the v1
// implementation is in-process; future revisions can swap in a
// shared-storage queue without changing the engine's API.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §18.

import Foundation

public protocol BackupQueue: Actor {
  func enqueue(_ task: BackupTask, priority: BackupPriority) async
  func cancel(_ id: BackupTaskID) async
  func dequeue() async -> BackupTask?
  func observe() -> AsyncStream<BackupQueueEvent>
  func snapshot() async -> [BackupTask]
  /// Broadcast an event to all observers. Used by BackupEngine to report
  /// .started / .completed / .failed transitions.
  func emit(_ event: BackupQueueEvent) async
}

public actor InProcessBackupQueue: BackupQueue {

  /// Internal entry with stable sequence number so ordering within a
  /// priority is deterministic across re-sorts.
  private struct Entry: Comparable {
    let task: BackupTask
    let priority: BackupPriority
    let seq: UInt64

    static func < (a: Entry, b: Entry) -> Bool {
      // Higher priority first. Within a priority, the newer capture
      // first (#3388) — a fresh capture that lands mid-backlog, or a
      // backlog rehydrated after relaunch in whatever order SQLite
      // returned it, both drain newest-first. Undated tasks go after
      // every dated one; ties fall back to FIFO by sequence.
      if a.priority != b.priority { return a.priority > b.priority }
      switch (a.task.capturedAt, b.task.capturedAt) {
      case (let x?, let y?) where x != y: return x > y
      case (.some, .none): return true
      case (.none, .some): return false
      default: return a.seq < b.seq
      }
    }
  }

  private var entries: [Entry] = []
  private var positions: [BackupTaskID: Int] = [:]
  private var nextSeq: UInt64 = 0
  private var continuations: [UUID: AsyncStream<BackupQueueEvent>.Continuation] = [:]

  public init() {}

  public func enqueue(_ task: BackupTask, priority: BackupPriority) async {
    // Indexed binary heap: O(log n) enqueue/dequeue at 100k assets.
    // A repeated notification must not enqueue a second copy of a task.
    if let index = positions[task.id] { remove(at: index) }
    let entry = Entry(task: task, priority: priority, seq: nextSeq)
    nextSeq &+= 1
    entries.append(entry)
    positions[task.id] = entries.count - 1
    siftUp(entries.count - 1)
    await emit(.enqueued(task))
  }

  public func cancel(_ id: BackupTaskID) async {
    if let index = positions[id] { remove(at: index) }
    await emit(.cancelled(id))
  }

  public func dequeue() async -> BackupTask? {
    guard let first = entries.first else { return nil }
    remove(at: 0)
    return first.task
  }

  private func swap(_ a: Int, _ b: Int) {
    entries.swapAt(a, b)
    positions[entries[a].task.id] = a
    positions[entries[b].task.id] = b
  }

  private func siftUp(_ start: Int) {
    var index = start
    while index > 0 {
      let parent = (index - 1) / 2
      guard entries[index] < entries[parent] else { break }
      swap(index, parent)
      index = parent
    }
  }

  private func remove(at index: Int) {
    let id = entries[index].task.id
    swap(index, entries.count - 1)
    entries.removeLast()
    positions[id] = nil
    guard index < entries.count else { return }
    if index > 0, entries[index] < entries[(index - 1) / 2] {
      siftUp(index)
      return
    }
    var cursor = index
    while cursor * 2 + 1 < entries.count {
      let left = cursor * 2 + 1
      let right = left + 1
      let child = right < entries.count && entries[right] < entries[left] ? right : left
      guard entries[child] < entries[cursor] else { break }
      swap(cursor, child)
      cursor = child
    }
  }

  public func observe() -> AsyncStream<BackupQueueEvent> {
    let id = UUID()
    return AsyncStream { continuation in
      self.continuations[id] = continuation
      continuation.onTermination = { [weak self] _ in
        guard let self else { return }
        Task { await self.removeContinuation(id) }
      }
    }
  }

  public func snapshot() async -> [BackupTask] {
    entries.sorted().map(\.task)
  }

  // MARK: - Internals

  public func emit(_ event: BackupQueueEvent) async {
    for continuation in continuations.values {
      continuation.yield(event)
    }
  }

  private func removeContinuation(_ id: UUID) {
    continuations.removeValue(forKey: id)
  }
}
