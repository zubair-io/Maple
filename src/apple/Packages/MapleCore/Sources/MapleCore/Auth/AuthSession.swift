// AuthSession.swift
import Foundation
import Observation
import OSLog

/// Logger for the auth subsystem. View in Xcode's debug console or
/// Console.app filtering on subsystem `app.justmaple.aperture.auth`.
/// Keep error-level events visible without being chatty.
let authLogger = Logger(subsystem: "app.justmaple.aperture.auth", category: "session")

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
    // Distinguish "Keychain says there's no entry" (definitive — clear
    // cached state) from "Keychain itself failed to read" (transient —
    // could be a locked Keychain, errSecInteractionNotAllowed, etc.;
    // preserve cached state so a future bootstrap can recover). The
    // previous `try?` collapsed both into nil and unconditionally
    // wiped the cache.
    let loaded: AuthTokens?
    do { loaded = try TokenStore.load(server: server) }
    catch {
      authLogger.error("TokenStore.load failed transiently: \(error.localizedDescription, privacy: .public) — preserving cached state")
      return
    }
    guard let tokens = loaded else {
      await clearLocalCredentials()
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
    } catch is AuthClientError {
      // .unauthorized / .forbidden — token is dead, fall through to
      // the refresh attempt below.
    } catch {
      // Untyped throw from a future code path — treat as transient
      // to preserve the cache; a real auth failure will resurface
      // through the typed branch above on the next API call.
      return
    }

    // /me said unauthorized. Try to refresh.
    let newTokens: AuthTokens
    do {
      newTokens = try await client.refreshTokens(refreshToken: tokens.refresh)
    } catch let e as AuthClientError where !e.isAuthFailure {
      // Refresh failed because the network died, the server returned
      // 5xx, or the response failed to decode. Tokens may still be
      // valid; do NOT clear them.
      return
    } catch {
      // Refresh was rejected (401/403) or hit an unexpected error type
      // we conservatively treat as rejection. Credentials are dead.
      await clearLocalCredentials()
      return
    }

    // Refresh succeeded — the server has invalidated the old refresh
    // token and issued a new pair. Persist them IMMEDIATELY so a
    // subsequent /me failure can't lose the rotation (which would
    // leave us holding a stale refresh token and force sign-in on
    // the next bootstrap).
    try? TokenStore.save(newTokens, server: server)
    hasCredentials = true
    await FileProviderDomainController().mirrorTokens(serverURL: server)

    // Fetch fresh user metadata with the new access token. Failure
    // here is transient — the rotated tokens are good, the cached
    // user (if any) remains correct, and the next bootstrap will
    // pick up the metadata.
    if let me = try? await client.me(accessToken: newTokens.access) {
      apply(user: me.user)
    }
  }

  public func signOut() async {
    if let tokens = try? TokenStore.load(server: server) {
      _ = try? await client.logout(accessToken: tokens.access, refreshToken: tokens.refresh)
    }
    await clearLocalCredentials()
  }

  public func setSignedIn(user: AuthUser, tokens: AuthTokens) throws {
    try TokenStore.save(tokens, server: server)
    AuthUserCache.save(user, server: server)
    self.user = user
    self.hasCredentials = true
    let server = self.server
    Task { await FileProviderDomainController().mirrorTokens(serverURL: server) }
  }

  private func apply(user: AuthUser) {
    self.user = user
    self.hasCredentials = true
    AuthUserCache.save(user, server: server)
  }

  private func clearLocalCredentials() async {
    TokenStore.clear(server: server)
    AuthUserCache.clear(server: server)
    user = nil
    hasCredentials = false
    await FileProviderDomainController().mirrorTokens(serverURL: server)
  }
}
