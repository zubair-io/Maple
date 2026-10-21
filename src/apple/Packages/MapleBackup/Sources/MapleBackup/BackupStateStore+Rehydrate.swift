import Foundation

extension BackupStateStore {
  /// Resumes the persisted backlog on engine start: pending rows re-enter the
  /// queue, and rows a stopped or crashed engine left uploading go back to
  /// pending first. On macOS, call it only while holding `BackupEngineLock`:
  /// another host's uploading rows are its live uploads (#4988). iOS has a
  /// single host and takes no lock (#5022).
  /// `priority` overrides each task's own; the count is the tasks enqueued.
  @discardableResult
  public func rehydrate(into queue: some BackupQueue, priority: BackupPriority? = nil)
    async throws -> Int
  {
    let pending = try tasks(in: .pending)
    let interrupted = try tasks(in: .uploading)
    for task in interrupted { try transition(task.id, to: .pending) }
    for task in pending + interrupted {
      await queue.enqueue(task, priority: priority ?? task.priority)
    }
    return pending.count + interrupted.count
  }
}
