// AuthClient.swift
import Foundation

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
  let server: URL
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

  public struct RefreshResult { public let tokens: AuthTokens; public let user: AuthUser }
  public func refresh(refreshToken: String) async throws -> RefreshResult {
    struct R: Decodable { let access_token: String; let refresh_token: String }
    let r: R = try await postJSON("/api/auth/refresh", body: ["refresh_token": refreshToken], auth: nil)
    let me: AuthMeResponse = try await get("/api/auth/me", auth: r.access_token)
    return RefreshResult(tokens: AuthTokens(access: r.access_token, refresh: r.refresh_token), user: me.user)
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
    let (data, resp) = try await urlSession.data(for: req)
    try checkStatus(resp, data: data)
    if T.self == EmptyResponse.self { return EmptyResponse() as! T }
    return try JSONDecoder().decode(T.self, from: data)
  }

  func postJSON<T: Decodable>(_ path: String, body: [String: Any], auth: String?) async throws -> T {
    var req = URLRequest(url: server.appending(path: path))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let auth { req.setValue("Bearer \(auth)", forHTTPHeaderField: "Authorization") }
    req.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, resp) = try await urlSession.data(for: req)
    try checkStatus(resp, data: data)
    if T.self == EmptyResponse.self { return EmptyResponse() as! T }
    return try JSONDecoder().decode(T.self, from: data)
  }

  func checkStatus(_ resp: URLResponse, data: Data) throws {
    let http = resp as! HTTPURLResponse
    if !(200..<300).contains(http.statusCode) {
      let msg = String(data: data, encoding: .utf8) ?? ""
      throw NSError(domain: "AuthClient", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: msg])
    }
  }
}
