// AuthClient.swift
import Foundation

/// Typed errors thrown by AuthClient so callers (notably AuthSession's
/// offline-aware bootstrap path) can distinguish a transient network
/// failure from a real authentication failure. Without this, the only
/// signal was an untyped `Error` and any failure forced a sign-out.
public enum AuthClientError: Error, Sendable {
  /// Transport-level failure: offline, DNS, TLS handshake, timeout.
  /// Tokens should NOT be cleared on this — the credentials are still
  /// valid; we just can't reach the server.
  case network(URLError)
  /// HTTP 401 — token is invalid or expired. Caller should refresh.
  case unauthorized(body: String)
  /// HTTP 403 — token is valid but the user lacks permission. Treat
  /// as a permanent auth failure for the current credentials.
  case forbidden(body: String)
  /// Any other non-2xx HTTP status.
  case http(status: Int, body: String)
  /// JSON decode failure on a 2xx response.
  case decode(Error)

  public var isAuthFailure: Bool {
    switch self {
    case .unauthorized, .forbidden: return true
    case .network, .http, .decode: return false
    }
  }

  public var isNetworkFailure: Bool {
    if case .network = self { return true }
    return false
  }
}

public struct AuthVerifyResponse: Decodable {
  public let access_token: String
  public let refresh_token: String
  public let user: AuthUser
}
public struct AuthMeResponse: Decodable {
  public let user: AuthUser
  public struct Cred: Decodable, Identifiable {
    public let id: String
    public let device_label: String
    public let last_used_at: String?
    public let created_at: String
  }
  public let credentials: [Cred]
}

public actor AuthClient {
  public nonisolated let server: URL
  let urlSession: URLSession
  public init(server: URL, urlSession: URLSession = .shared) {
    self.server = server; self.urlSession = urlSession
  }

  public func bootstrap() async throws -> Bool {
    struct R: Decodable { let claimed: Bool }
    let r: R = try await get("/api/auth/bootstrap", auth: nil)
    return r.claimed
  }

  public func me(accessToken: String) async throws -> AuthMeResponse {
    return try await get("/api/auth/me", auth: accessToken)
  }

  /// POSTs `/api/auth/refresh` and returns the rotated tokens. The
  /// caller is expected to persist these IMMEDIATELY before doing
  /// anything else — the server has already invalidated the old
  /// refresh token, so any error path that drops the new pair makes
  /// the credentials unrecoverable. (The previous `refresh()` chained
  /// `/api/auth/me` inline and threw on its failure, which lost the
  /// rotation when `/me` 5xx'd post-rotation. That's why this version
  /// is tokens-only.)
  public func refreshTokens(refreshToken: String) async throws -> AuthTokens {
    struct R: Decodable { let access_token: String; let refresh_token: String }
    let r: R = try await postJSON("/api/auth/refresh", body: ["refresh_token": refreshToken], auth: nil)
    return AuthTokens(access: r.access_token, refresh: r.refresh_token)
  }

  public func logout(accessToken: String, refreshToken: String) async throws {
    _ = try await postJSON("/api/auth/logout",
                           body: ["refresh_token": refreshToken],
                           auth: accessToken) as EmptyResponse
  }

  // MARK: - Helpers
  struct EmptyResponse: Decodable {}

  func get<T: Decodable>(_ path: String, auth: String?) async throws -> T {
    var req = URLRequest(url: server.appending(path: path))
    if let auth { req.setValue("Bearer \(auth)", forHTTPHeaderField: "Authorization") }
    let (data, resp) = try await send(req)
    try checkStatus(resp, data: data)
    if T.self == EmptyResponse.self { return EmptyResponse() as! T }
    do { return try JSONDecoder().decode(T.self, from: data) }
    catch { throw AuthClientError.decode(error) }
  }

  func postJSON<T: Decodable>(_ path: String, body: [String: Any], auth: String?) async throws -> T {
    var req = URLRequest(url: server.appending(path: path))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let auth { req.setValue("Bearer \(auth)", forHTTPHeaderField: "Authorization") }
    req.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, resp) = try await send(req)
    try checkStatus(resp, data: data)
    if T.self == EmptyResponse.self { return EmptyResponse() as! T }
    do { return try JSONDecoder().decode(T.self, from: data) }
    catch { throw AuthClientError.decode(error) }
  }

  /// Wraps URLSession.data so transport failures (offline, DNS, timeout)
  /// surface as `AuthClientError.network` instead of bare URLError —
  /// gives callers a structured signal to keep tokens on transient
  /// failures and only clear them on real auth rejections.
  func send(_ req: URLRequest) async throws -> (Data, URLResponse) {
    do { return try await urlSession.data(for: req) }
    catch let e as URLError { throw AuthClientError.network(e) }
  }

  func checkStatus(_ resp: URLResponse, data: Data) throws {
    let http = resp as! HTTPURLResponse
    let code = http.statusCode
    if (200..<300).contains(code) { return }
    let body = String(data: data, encoding: .utf8) ?? ""
    switch code {
    case 401: throw AuthClientError.unauthorized(body: body)
    case 403: throw AuthClientError.forbidden(body: body)
    default:  throw AuthClientError.http(status: code, body: body)
    }
  }
}

// Note: native WebAuthn ceremony helpers (register / login /
// PasskeyCeremony) were removed when the AddMapleCloud flow switched to
// a webview. Native ASAuthorizationController requires the app to list
// every domain it can authenticate against in its Associated Domains
// entitlement at build time — fundamentally incompatible with a multi-
// tenant / self-hosted product where each customer brings their own
// domain. Sign-in now happens inside a WKWebView that captures tokens
// via a JS bridge (see WebViewSignInPanel.swift).

// MARK: - Invites + credentials management

extension AuthClient {
  public func createInvite(email: String, accessToken: String) async throws -> (code: String, expiresAt: String) {
    struct R: Decodable { let code: String; let expires_at: String }
    let r: R = try await postJSON("/api/auth/invites", body: ["email": email], auth: accessToken)
    return (r.code, r.expires_at)
  }

  public func listInvites(accessToken: String) async throws -> [[String: Any]] {
    return try await getRaw("/api/auth/invites", auth: accessToken)
  }

  public func rescindInvite(code: String, accessToken: String) async throws {
    var req = URLRequest(url: server.appending(path: "/api/auth/invites/\(code)"))
    req.httpMethod = "DELETE"
    req.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    let (data, resp) = try await send(req)
    try checkStatus(resp, data: data)
  }

  public func deleteCredential(id: String, accessToken: String) async throws {
    var req = URLRequest(url: server.appending(path: "/api/auth/credentials/\(id)"))
    req.httpMethod = "DELETE"
    req.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    let (data, resp) = try await send(req)
    try checkStatus(resp, data: data)
  }

  func getRaw(_ path: String, auth: String?) async throws -> [[String: Any]] {
    var req = URLRequest(url: server.appending(path: path))
    if let auth { req.setValue("Bearer \(auth)", forHTTPHeaderField: "Authorization") }
    let (data, resp) = try await send(req)
    try checkStatus(resp, data: data)
    return (try JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
  }

  // MARK: - Preview

  /// Sample `AuthClient` for SwiftUI `#Preview` blocks. Pointed at a
  /// non-routable example URL so any accidental network call in a preview
  /// fails fast rather than hitting a real server. Issue #139.
  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> AuthClient {
    AuthClient(server: server)
  }
}
