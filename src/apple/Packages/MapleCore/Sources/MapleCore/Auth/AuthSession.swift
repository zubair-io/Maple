// AuthSession.swift
import Foundation
import Observation

public struct AuthUser: Codable, Equatable {
  public let id: String
  public let email: String
  public let role: String
  public var isOwner: Bool { role == "owner" }
}

@MainActor @Observable
public final class AuthSession {
  public private(set) var server: URL
  public private(set) var user: AuthUser?
  public var isSignedIn: Bool { user != nil }
  public var isOwner: Bool { user?.isOwner ?? false }

  private let client: AuthClient

  public init(server: URL, client: AuthClient) {
    self.server = server; self.client = client
  }

  public func bootstrapAndRestore() async {
    if let tokens = (try? TokenStore.load(server: server)) {
      do {
        let me = try await client.me(accessToken: tokens.access)
        user = me.user
      } catch {
        // Try refresh once.
        if let new = try? await client.refresh(refreshToken: tokens.refresh) {
          try? TokenStore.save(new.tokens, server: server)
          user = new.user
        } else {
          TokenStore.clear(server: server); user = nil
        }
      }
    }
  }

  public func signOut() async {
    if let tokens = try? TokenStore.load(server: server) {
      _ = try? await client.logout(accessToken: tokens.access, refreshToken: tokens.refresh)
    }
    TokenStore.clear(server: server)
    user = nil
  }

  public func setSignedIn(user: AuthUser, tokens: AuthTokens) throws {
    try TokenStore.save(tokens, server: server)
    self.user = user
  }
}
