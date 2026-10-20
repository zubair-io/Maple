// Sources/MapleBackup/SerialOperationQueue.swift
//
// Runs async operations one at a time, in call order (#5022). EngineHost puts
// every start and stop through one, so a second Stop, a BGTask expiry or a new
// Start can never interleave with a teardown that is still draining work that
// writes the shared state DB.

/// Operations run one after another; each runs to completion even if the task
/// that queued it is cancelled, so a teardown is never abandoned halfway.
@MainActor
public final class SerialOperationQueue {
  private var tail: Task<Void, Never>?

  public init() {}

  public func run(_ operation: @escaping @MainActor () async -> Void) async {
    let previous = tail
    let next = Task { @MainActor in
      await previous?.value
      await operation()
    }
    tail = next
    await next.value
  }
}
