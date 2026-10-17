import Foundation

/// Serializes refresh persistence with logout so an in-flight rotation cannot restore credentials.
final class WatchCredentialLease: @unchecked Sendable {
  private let lock = NSLock()
  private var active = true

  func whileActive<T>(_ operation: () throws -> T) throws -> T {
    lock.lock()
    defer { lock.unlock() }
    guard active else { throw CancellationError() }
    return try operation()
  }

  /// Returns true once, making repeated expiry callbacks harmless.
  @discardableResult
  func invalidate(_ operation: () -> Void = {}) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard active else { return false }
    active = false
    operation()
    return true
  }
}
