import Foundation

/// Builds authenticated streaming URLs for media transports such as AVPlayer,
/// which cannot attach Maple's bearer header to their byte-range requests.
///
/// `/api/video/fs` intentionally accepts Maple's signed 15-minute access token
/// in the query string. This is the same transport contract used by
/// `CloudSource.videoURL(for:)`: the API strips query strings from auth logs
/// and returns `Referrer-Policy: no-referrer` to keep the token out of referrer
/// and application log data.
public actor CloudVideoClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  public func streamingURL(absPath: String) async throws -> URL {
    let token = try await httpClient.accessTokenForURL()
    return Self.streamingURL(server: server, absPath: absPath, token: token)
  }

  public nonisolated static func streamingURL(
    server: URL,
    absPath: String,
    token: String
  ) -> URL {
    var components = URLComponents(
      url: server.appending(path: "/api/video/fs"),
      resolvingAgainstBaseURL: false
    )!
    components.queryItems = (components.queryItems ?? []) + [
      URLQueryItem(name: "path", value: absPath),
      URLQueryItem(name: "token", value: token),
    ]
    return components.url!
  }
}
