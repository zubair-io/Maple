import Foundation

/// Lets exactly one of the user's Disconnect and a server-side expiry end a session.
final class WatchSessionEnding: @unchecked Sendable {
  private let lock = NSLock()
  private var ended = false

  /// True only for the first caller.
  func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !ended else { return false }
    ended = true
    return true
  }
}
