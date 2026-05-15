// AuthSession.swift
import Foundation
import Observation

public struct AuthUser: Codable, Equatable, Sendable {
  public let id: String
  public let email: String
  public let role: String
  public var isOwner: Bool { role == "owner" }

  public init(id: String, email: String, role: String) {
    self.id = id
    self.email = email
    self.role = role
  }
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
    // Hydrate user from the on-disk cache when a Keychain token also
    // exists, so cold-start `isSignedIn` is true before any network
    // round-trip. The previous behaviour left `user = nil` until
    // bootstrapAndRestore() finished, which forced the sign-in sheet
    // to appear on every cold start when offline — even with valid
    // tokens. Bootstrap will still run, verify, and refresh the cached
    // user when the network comes back.
    if (try? TokenStore.load(server: server)) != nil,
       let cached = AuthUserCache.load(server: server) {
      self.user = cached
    }
  }

  public func bootstrapAndRestore() async {
    guard let tokens = (try? TokenStore.load(server: server)) else {
      user = nil
      AuthUserCache.clear(server: server)
      return
    }
    do {
      let me = try await client.me(accessToken: tokens.access)
      user = me.user
      AuthUserCache.save(me.user, server: server)
      return
    } catch let e as AuthClientError {
      if e.isNetworkFailure {
        // Offline / DNS / TLS — credentials are still good, keep the
        // cached user so the UI doesn't force a sign-in.
        return
      }
      if e.isAuthFailure {
        // 401/403 — fall through to refresh below.
      } else {
        // 5xx / decode — keep cached user, treat as transient.
        return
      }
    } catch {
      // Defensive: any other untyped error treated as transient. The
      // cost of an unnecessary sign-out is worse than a stale cached
      // user, since the worst case is the next API call surfaces a
      // real 401 that re-enters this branch through the refresh path.
      return
    }

    // Reached only on 401/403. Try a single refresh.
    do {
      let new = try await client.refresh(refreshToken: tokens.refresh)
      try? TokenStore.save(new.tokens, server: server)
      user = new.user
      AuthUserCache.save(new.user, server: server)
    } catch let e as AuthClientError where e.isNetworkFailure {
      // Network died between /me and /refresh — leave state alone.
      return
    } catch {
      // Refresh failed for a non-network reason. Tokens are dead.
      TokenStore.clear(server: server)
      AuthUserCache.clear(server: server)
      user = nil
    }
  }

  public func signOut() async {
    if let tokens = try? TokenStore.load(server: server) {
      _ = try? await client.logout(accessToken: tokens.access, refreshToken: tokens.refresh)
    }
    TokenStore.clear(server: server)
    AuthUserCache.clear(server: server)
    user = nil
  }

  public func setSignedIn(user: AuthUser, tokens: AuthTokens) throws {
    try TokenStore.save(tokens, server: server)
    AuthUserCache.save(user, server: server)
    self.user = user
  }
}
