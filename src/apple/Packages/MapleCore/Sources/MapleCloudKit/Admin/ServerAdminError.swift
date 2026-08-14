// ServerAdminError.swift — one error shape for every /api admin client.
//
// The API's failure envelope is `{ "error": "<message>" }` on 4xx/5xx
// (see src/api/src/routes/network.ts and routes/cloudflare.ts). Callers
// render `message` inline, so decoding it here keeps every admin client
// from re-implementing the same unwrap.

import Foundation

public struct ServerAdminError: Error, LocalizedError, Equatable, Sendable {
  public let statusCode: Int
  public let message: String

  public init(statusCode: Int, message: String) {
    self.statusCode = statusCode
    self.message = message
  }

  public var errorDescription: String? { message }

  /// Envelope shape the API returns on failure.
  private struct Envelope: Decodable { let error: String }

  /// Returns an error for any non-2xx response, or nil when the response
  /// succeeded. A body that isn't the `{ error }` envelope falls back to
  /// the raw UTF-8 body, then to a generic status line — a 502 from a
  /// proxy won't be JSON, and an empty message reads as a silent failure.
  public static func from(data: Data, response: URLResponse) -> ServerAdminError? {
    guard let http = response as? HTTPURLResponse else { return nil }
    guard !(200..<300).contains(http.statusCode) else { return nil }
    let decoded = try? JSONDecoder().decode(Envelope.self, from: data)
    let body = String(data: data, encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let message = decoded?.error
      ?? (body?.isEmpty == false ? body! : "Request failed with status \(http.statusCode).")
    return ServerAdminError(statusCode: http.statusCode, message: message)
  }
}
