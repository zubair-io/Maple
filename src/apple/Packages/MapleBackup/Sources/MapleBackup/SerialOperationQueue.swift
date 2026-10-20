/// Runs async operations one at a time, in call order; each runs to completion
/// even if the task that queued it is cancelled, so a teardown is never
/// abandoned halfway (#5022).
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
