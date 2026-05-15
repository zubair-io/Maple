// src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AuthenticatedHTTPClient.swift
import Foundation
import OSLog

/// Logger for the cloud HTTP layer. View live in Xcode's debug console
/// or via Console.app filtering on subsystem `app.justmaple.aperture.cloud`
/// category `http`. Verbose bodies are at `.debug` level so they're
/// visible in development but stripped from release archives.
let cloudHTTPLogger = Logger(
  subsystem: "app.justmaple.aperture.cloud",
  category: "http"
)

public actor AuthenticatedHTTPClient {
  private let server: URL
  private let urlSession: URLSession
  private let tokensProvider: () -> AuthTokens?
  private let onTokensRefreshed: (AuthTokens) -> Void
  private let onSignOut: () -> Void
  private var inflightRefresh: Task<AuthTokens, Error>?

  public init(server: URL, urlSession: URLSession,
              tokensProvider: @escaping () -> AuthTokens?,
              onTokensRefreshed: @escaping (AuthTokens) -> Void = { _ in },
              onSignOut: @escaping () -> Void) {
    self.server = server; self.urlSession = urlSession
    self.tokensProvider = tokensProvider; self.onTokensRefreshed = onTokensRefreshed
    self.onSignOut = onSignOut
  }

  public func data(for request: URLRequest) async throws -> (Data, URLResponse) {
    Self.logRequest(request, attempt: 1)
    let (data, resp) = try await dataOnce(request: inject(request, tokens: tokensProvider()))
    Self.logResponse(resp, data: data, request: request)

    if (resp as? HTTPURLResponse)?.statusCode != 401 { return (data, resp) }

    cloudHTTPLogger.info("401 — attempting token refresh")
    guard let current = tokensProvider() else { onSignOut(); return (data, resp) }
    let fresh: AuthTokens
    do { fresh = try await refresh(refresh: current.refresh) }
    catch let e as URLError {
      // Transport-level failure during refresh — the user went offline
      // mid-flight. Surface the URLError to the caller so it can fall
      // back to its own cache instead of treating this as a sign-out.
      // Tokens stay in the Keychain; next time we have network we'll
      // try again.
      cloudHTTPLogger.error("token refresh network error: \(e.localizedDescription, privacy: .public)")
      throw e
    } catch let e as AuthClientError where e.isNetworkFailure {
      // Defensive: if refresh is ever routed through AuthClient (which
      // wraps URLError into AuthClientError.network) the URLError catch
      // above stops matching. Re-throw network failures here so we
      // don't silently sign the user out the moment that refactor lands.
      cloudHTTPLogger.error("token refresh network error: \(e.localizedDescription, privacy: .public)")
      throw e
    } catch {
      cloudHTTPLogger.error("token refresh failed: \(error.localizedDescription, privacy: .public)")
      onSignOut(); return (data, resp)
    }
    onTokensRefreshed(fresh)
    Self.logRequest(request, attempt: 2)
    let retried = try await dataOnce(request: inject(request, tokens: fresh))
    Self.logResponse(retried.1, data: retried.0, request: request)
    return retried
  }

  /// Sentinel thrown by the refresh task when the refresh endpoint
  /// returns a non-200 response. We use a distinct error type from
  /// URLError so the caller can tell "refresh said no" (sign-out is
  /// correct) from "refresh couldn't reach the server" (keep tokens).
  private struct RefreshRejected: Error {}

  /// Hits `/api/auth/refresh` directly through `urlSession`, NOT through
  /// `AuthClient` — by contract, transport failures here surface as a
  /// bare `URLError` (and only as a `URLError`), which the caller
  /// distinguishes from a server-side rejection (`RefreshRejected`) to
  /// decide whether to sign out. If you route this through `AuthClient`
  /// in the future, update the caller's catch ladder to handle
  /// `AuthClientError.network` as a transport failure too — there is
  /// already a defensive catch upstream so the change won't silently
  /// break, but the contract here is "URLError = transport."
  private func refresh(refresh refreshToken: String) async throws -> AuthTokens {
    if let t = inflightRefresh { return try await t.value }
    let task = Task { () throws -> AuthTokens in
      var req = URLRequest(url: server.appending(path: "/api/auth/refresh"))
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONSerialization.data(withJSONObject: ["refresh_token": refreshToken])
      let (data, resp) = try await urlSession.data(for: req)
      guard (resp as! HTTPURLResponse).statusCode == 200 else { throw RefreshRejected() }
      struct R: Decodable { let access_token: String; let refresh_token: String }
      let r = try JSONDecoder().decode(R.self, from: data)
      return AuthTokens(access: r.access_token, refresh: r.refresh_token)
    }
    inflightRefresh = task
    defer { inflightRefresh = nil }
    return try await task.value
  }

  private func inject(_ req: URLRequest, tokens: AuthTokens?) -> URLRequest {
    var r = req
    if let t = tokens { r.setValue("Bearer \(t.access)", forHTTPHeaderField: "Authorization") }
    return r
  }

  private func dataOnce(request: URLRequest) async throws -> (Data, URLResponse) {
    try await urlSession.data(for: request)
  }

  // MARK: - Logging helpers

  /// URL paths and query parameters can carry user data (filenames, ids).
  /// We log them at `.public` because debugging a multi-tenant cloud
  /// without seeing the actual URL is impractical. Bodies are NOT logged
  /// (could contain tokens) except for the response body's first 512
  /// bytes, which is enough to diagnose decode failures and short error
  /// payloads but truncates auth responses before tokens leak.
  private static func logRequest(_ req: URLRequest, attempt: Int) {
    let method = req.httpMethod ?? "GET"
    let url = req.url?.absoluteString ?? "<no-url>"
    let attemptNote = attempt > 1 ? " (retry #\(attempt))" : ""
    cloudHTTPLogger.debug("→ \(method, privacy: .public) \(url, privacy: .public)\(attemptNote, privacy: .public)")
  }

  private static func logResponse(_ resp: URLResponse, data: Data, request req: URLRequest) {
    let url = req.url?.absoluteString ?? "<no-url>"
    let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
    let bytes = data.count
    cloudHTTPLogger.debug("← \(status, privacy: .public) \(bytes, privacy: .public)B  \(url, privacy: .public)")

    // Log the body preview ONLY for 4xx/5xx (error payloads, usually JSON
    // error messages) and for plausibly-textual successful responses
    // small enough to be a JSON document, not a thumbnail. Skips
    // /api/auth/* responses entirely so access/refresh tokens never reach
    // the log.
    let isAuthEndpoint = url.contains("/api/auth/")
    let isError = !(200..<300).contains(status)
    let isSmallText = bytes > 0 && bytes < 8192
    let contentType = (resp as? HTTPURLResponse)?
      .value(forHTTPHeaderField: "Content-Type") ?? ""
    let looksTextual = contentType.contains("json")
                     || contentType.contains("text")
                     || contentType.isEmpty

    if !isAuthEndpoint && (isError || (isSmallText && looksTextual)) {
      let preview = String(data: data.prefix(512), encoding: .utf8) ?? "<non-utf8 \(bytes)B>"
      cloudHTTPLogger.debug("← body: \(preview, privacy: .public)")
    }
  }
}
