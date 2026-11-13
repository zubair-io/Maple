import Foundation

/// How long a visible Preview page waits before re-asking for its display
/// tier after a failure (#5432): 2, 4, 8, 16 s, then every 16 s. A 202
/// "indexing" reply waits at least the server's `Retry-After`, capped at
/// 60 s. A terminal outcome (404) stops.
public struct PreviewRefinementBackoff: Sendable {
  static let schedule: [TimeInterval] = [2, 4, 8, 16]
  static let maximumRetryAfter: TimeInterval = 60

  private(set) var failures = 0

  public init() {}

  /// Seconds to wait before the next attempt, or nil when the outcome is
  /// not worth retrying. Every retryable failure advances the schedule.
  public mutating func delay(after outcome: PreviewFetchOutcome) -> TimeInterval? {
    guard outcome.isRetryable else { return nil }
    let scheduled = Self.schedule[min(failures, Self.schedule.count - 1)]
    failures += 1
    guard case .indexing(let retryAfter?) = outcome else { return scheduled }
    return max(scheduled, min(retryAfter, Self.maximumRetryAfter))
  }

  public mutating func reset() {
    failures = 0
  }
}
