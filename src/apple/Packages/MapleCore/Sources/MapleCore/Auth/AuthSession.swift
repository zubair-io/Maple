// AuthSession.swift
//
// Stays in MapleCore (not MapleCloudKit) — unlike the rest of the Auth/
// directory — because it calls `FileProviderDomainController`, which
// integrates with the FileProvider framework and is not portable to tvOS
// (2026-07-18, Maple TV milestone A, MapleCloudKit extraction). `AuthUser`
// and `authLogger`, formerly declared in this file, moved to
// MapleCloudKit/Auth/AuthUser.swift since four MapleCloudKit files
// (AddMapleCloudState, AddMapleCloudViewModel, AuthClient, AuthUserCache)
// need them; this file imports MapleCloudKit to keep using them.
import Foundation
import MapleCloudKit
import Observation
import OSLog

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

  /// Forced local sign-out driven by the HTTP layer when a *live* request's
  /// token refresh is rejected (the refresh token is expired/revoked) or a
  /// request 401s with no tokens left to refresh. Clears the Keychain
  /// credentials and flips `isSignedIn` to false so the sidebar surfaces its
  /// "Sign in" affordance and the cold-start guards stop firing tokenless
  /// requests.
  ///
  /// This is the load-bearing reconciliation point: `AuthenticatedHTTPClient`
  /// previously cleared only the Keychain on a rejected refresh, leaving this
  /// observable session stuck at `isSignedIn == true`. The next request then
  /// passed the `guard session.isSignedIn` checks and went out with no bearer
  /// (`tokensProvider()` now returns nil) → the server's "missing bearer" 401.
  /// Routing the client's `onSignOut` here keeps the HTTP token lifecycle and
  /// the observable auth state as one source of truth — the Apple analogue of
  /// the web `AuthService`'s 401→clear path.
  ///
  /// Unlike `signOut()`, this does NOT POST to `/api/auth/logout`: the tokens
  /// are already dead, so there is nothing to revoke server-side.
  public func handleAuthExpired() async {
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

  // MARK: - Preview

  public enum PreviewState: Sendable {
    case signedOut
    case signedInOwner
    case signedInMember
  }

  /// Sample `AuthSession` for SwiftUI `#Preview` blocks. Constructs against
  /// `AuthClient.preview()` so the underlying URL is non-routable; the
  /// `user` / `hasCredentials` fields are then mutated directly to fake the
  /// requested signed-in state without hitting the Keychain. Issue #139.
  public static func preview(
    state: PreviewState = .signedInOwner,
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> AuthSession {
    let session = AuthSession(server: server, client: AuthClient.preview(server: server))
    switch state {
    case .signedOut:
      session.user = nil
      session.hasCredentials = false
    case .signedInOwner:
      session.user = AuthUser(id: "preview-owner", email: "owner@example.com", role: "owner")
      session.hasCredentials = true
    case .signedInMember:
      session.user = AuthUser(id: "preview-member", email: "member@example.com", role: "member")
      session.hasCredentials = true
    }
    return session
  }
}
