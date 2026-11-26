import Foundation

/// Polls `condition`, yielding between checks, until it holds or `timeout`
/// elapses; returns the final answer.
func waitForCondition(
  timeout: Duration = .seconds(2),
  condition: @Sendable () async -> Bool
) async -> Bool {
  let clock = ContinuousClock()
  let deadline = clock.now + timeout
  while clock.now < deadline {
    if await condition() { return true }
    await Task.yield()
  }
  return await condition()
}
