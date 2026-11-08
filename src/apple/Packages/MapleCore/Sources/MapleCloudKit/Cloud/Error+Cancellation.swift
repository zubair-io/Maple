import Foundation

extension Error {
  /// Cancelled work, whichever layer reported it: Swift concurrency, or a
  /// `URLSession` request that was cancelled. Cancellation is never a
  /// failure to show the user.
  public var isCancellation: Bool {
    if self is CancellationError { return true }
    if let urlError = self as? URLError, urlError.code == .cancelled { return true }
    let ns = self as NSError
    return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
  }
}
