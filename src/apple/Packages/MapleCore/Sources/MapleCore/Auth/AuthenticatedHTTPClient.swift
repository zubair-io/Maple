// src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AuthenticatedHTTPClient.swift
import Foundation

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
    let (data, resp) = try await dataOnce(request: inject(request, tokens: tokensProvider()))
    if (resp as? HTTPURLResponse)?.statusCode != 401 { return (data, resp) }
    guard let current = tokensProvider() else { onSignOut(); return (data, resp) }
    let fresh: AuthTokens
    do { fresh = try await refresh(refresh: current.refresh) }
    catch { onSignOut(); return (data, resp) }
    onTokensRefreshed(fresh)
    return try await dataOnce(request: inject(request, tokens: fresh))
  }

  private func refresh(refresh refreshToken: String) async throws -> AuthTokens {
    if let t = inflightRefresh { return try await t.value }
    let task = Task { () throws -> AuthTokens in
      var req = URLRequest(url: server.appending(path: "/api/auth/refresh"))
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONSerialization.data(withJSONObject: ["refresh_token": refreshToken])
      let (data, resp) = try await urlSession.data(for: req)
      guard (resp as! HTTPURLResponse).statusCode == 200 else { throw URLError(.userAuthenticationRequired) }
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
}
