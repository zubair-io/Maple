import Foundation

/// What one display-tier (`/api/preview/:slug/*`) request produced (#5432),
/// so a Preview page can tell "retry after N s" from "stop asking".
public enum PreviewFetchOutcome: Sendable, Equatable {
  case data(Data)
  /// The server has no catalog row for the file yet. `retryAfter` is the
  /// server's `Retry-After` in seconds, when it sent a parseable one.
  case indexing(retryAfter: TimeInterval?)
  /// Nothing will ever be served for this asset; retrying cannot help.
  case notFound(reason: String)
  /// Network error, timeout, auth refresh, throttling or 5xx.
  case transientFailure(reason: String)

  public var data: Data? {
    if case .data(let bytes) = self { return bytes }
    return nil
  }

  public var isRetryable: Bool {
    switch self {
    case .indexing, .transientFailure: return true
    case .data, .notFound: return false
    }
  }

  /// An HTTP status or URLError code, never the request URL: it can name
  /// private folders.
  public var reason: String? {
    switch self {
    case .data: return nil
    case .indexing(let retryAfter):
      return retryAfter.map { "http 202 retry-after \(Int($0))s" } ?? "http 202"
    case .notFound(let reason), .transientFailure(let reason): return reason
    }
  }

  public static func classify(data: Data, response: URLResponse) -> PreviewFetchOutcome {
    guard let http = response as? HTTPURLResponse else {
      return .transientFailure(reason: "non-http response")
    }
    let status = http.statusCode
    switch status {
    case 202:
      return .indexing(retryAfter: retryAfterSeconds(http.value(forHTTPHeaderField: "Retry-After")))
    case 200..<300:
      guard !data.isEmpty else { return .transientFailure(reason: "http \(status) empty body") }
      return .data(data)
    case 401, 408, 429:
      return .transientFailure(reason: "http \(status)")
    case 400..<500:
      return .notFound(reason: "http \(status)")
    default:
      return .transientFailure(reason: "http \(status)")
    }
  }

  public static func classify(error: Error) -> PreviewFetchOutcome {
    if let urlError = error as? URLError {
      return .transientFailure(reason: "urlerror \(urlError.code.rawValue)")
    }
    if let addressError = error as? CloudAddressError {
      switch addressError {
      case .unregisteredPath: return .notFound(reason: "unregistered path")
      case .unrepresentableAddress: return .notFound(reason: "unrepresentable address")
      }
    }
    if error is CancellationError { return .transientFailure(reason: "cancelled") }
    let nsError = error as NSError
    return .transientFailure(reason: "\(nsError.domain) \(nsError.code)")
  }

  /// Delta-seconds form only; the server never sends the HTTP-date form.
  static func retryAfterSeconds(_ header: String?) -> TimeInterval? {
    guard let header, let seconds = TimeInterval(header.trimmingCharacters(in: .whitespaces)),
      seconds.isFinite, seconds >= 0
    else { return nil }
    return seconds
  }
}
