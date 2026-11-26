import XCTest

func pollUntil(
  timeout: Duration = .seconds(5),
  isolation: isolated (any Actor)? = #isolation,
  _ condition: () -> Bool
) async -> Bool {
  let deadline = ContinuousClock.now + timeout
  while ContinuousClock.now < deadline {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return false
}

final class LockedValue<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Value

  init(_ value: Value) { stored = value }

  var value: Value {
    get { lock.withLock { stored } }
    set { lock.withLock { stored = newValue } }
  }

  func mutate(_ change: (inout Value) -> Void) { lock.withLock { change(&stored) } }
}
