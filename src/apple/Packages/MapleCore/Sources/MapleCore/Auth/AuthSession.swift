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
  /// True when a Keychain credential exists for this server. Initialised
  /// synchronously from a sync Keychain read so cold-start `isSignedIn`
  /// is correct before any network call. This is the load-bearing
  /// signal — `user` is only metadata for the UI. The two-source design
  /// covers the upgrade path where the Keychain has tokens but the
  /// AuthUserCache file does not (a user upgrading from a build prior
  /// to that cache being introduced); without `hasCredentials` they
  /// would still see the sign-in sheet on the first cold offline
  /// launch, defeating the whole point of the cache.
  public private(set) var hasCredentials: Bool
  public var isSignedIn: Bool { hasCredentials || user != nil }
  public var isOwner: Bool { user?.isOwner ?? false }

  private let client: AuthClient

  public init(server: URL, client: AuthClient) {
    self.server = server
    self.client = client
    self.hasCredentials = (try? TokenStore.load(server: server)) != nil
    // Hydrate the user metadata from disk so the UI can render an
    // identity (email, owner badge) before bootstrap completes. Purely
    // a UX nicety — the Keychain presence above is what makes
    // isSignedIn true.
    if hasCredentials {
      self.user = AuthUserCache.load(server: server)
    }
  }

  public func bootstrapAndRestore() async {
    guard let tokens = (try? TokenStore.load(server: server)) else {
      clearLocalCredentials()
      return
    }
    do {
      let me = try await client.me(accessToken: tokens.access)
      apply(user: me.user)
      return
    } catch let e as AuthClientError where !e.isAuthFailure {
      // .network / .http(5xx) / .decode — keep cached state. The
      // server (or transport) is misbehaving, not the user's
      // credentials.
      return
    } catch let e as AuthClientError {
      // .unauthorized / .forbidden — token is dead, fall through to
      // the refresh attempt below.
      _ = e
    } catch {
      // Untyped throw from a future code path — treat as transient
      // to preserve the cache; a real auth failure will resurface
      // through the typed branch above on the next API call.
      return
    }

    do {
      let new = try await client.refresh(refreshToken: tokens.refresh)
      try? TokenStore.save(new.tokens, server: server)
      apply(user: new.user)
    } catch let e as AuthClientError where !e.isAuthFailure {
      // Refresh failed because the network died, the server returned
      // 5xx, or the response failed to decode. Tokens may still be
      // valid; do NOT clear them. The previous catch-all here cleared
      // tokens on every non-network AuthClientError, including 5xx
      // from /api/auth/refresh — that's the bug Copilot flagged.
      return
    } catch {
      // Refresh was rejected with 401/403 (or an unexpected error type
      // that we conservatively treat as a real rejection — anything
      // transient should have been caught by the typed branch above).
      // Credentials are dead; clear everything so the next bootstrap
      // routes to the sign-in sheet.
      clearLocalCredentials()
    }
  }

  public func signOut() async {
    if let tokens = try? TokenStore.load(server: server) {
      _ = try? await client.logout(accessToken: tokens.access, refreshToken: tokens.refresh)
    }
    clearLocalCredentials()
  }

  public func setSignedIn(user: AuthUser, tokens: AuthTokens) throws {
    try TokenStore.save(tokens, server: server)
    AuthUserCache.save(user, server: server)
    self.user = user
    self.hasCredentials = true
  }

  private func apply(user: AuthUser) {
    self.user = user
    self.hasCredentials = true
    AuthUserCache.save(user, server: server)
  }

  private func clearLocalCredentials() {
    TokenStore.clear(server: server)
    AuthUserCache.clear(server: server)
    user = nil
    hasCredentials = false
  }
}
