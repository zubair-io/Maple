// Sources/MapleBackup/BackupQueue.swift
//
// Priority-ordered backup task queue with observable event stream.
// Decouples the BackupEngine from the worker infrastructure — the v1
// implementation is in-process; future revisions can swap in a
// shared-storage queue without changing the engine's API.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §18.

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

    /// Internal entry with stable sequence number so FIFO within a priority
    /// is deterministic across re-sorts.
    private struct Entry: Comparable {
        let task: BackupTask
        let priority: BackupPriority
        let seq: UInt64

        static func < (a: Entry, b: Entry) -> Bool {
            // Higher priority first; same priority → earlier sequence first.
            if a.priority != b.priority { return a.priority > b.priority }
            return a.seq < b.seq
        }
    }

    private var entries: [Entry] = []
    private var nextSeq: UInt64 = 0
    private var continuations: [UUID: AsyncStream<BackupQueueEvent>.Continuation] = [:]

    public init() {}

    public func enqueue(_ task: BackupTask, priority: BackupPriority) async {
        entries.append(Entry(task: task, priority: priority, seq: nextSeq))
        nextSeq &+= 1
        entries.sort()
        await emit(.enqueued(task))
    }

    public func cancel(_ id: BackupTaskID) async {
        entries.removeAll { $0.task.id == id }
        await emit(.cancelled(id))
    }

    public func dequeue() async -> BackupTask? {
        guard !entries.isEmpty else { return nil }
        return entries.removeFirst().task
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
        entries.map(\.task)
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
