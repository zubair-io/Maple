// CloudHTTPClientFactory.swift — one construction site for authenticated
// cloud clients.
//
// Extracted from AppShell+CloudActions so ServerAdmin (#2766) builds an
// identically-configured client without depending on AppShell. Two
// separate constructions would be free to drift on the two behaviours the
// comments below call out — rotation mirroring and sign-out — and both
// failure modes are silent.

import Foundation
import MapleCore

/// Builds an `AuthenticatedHTTPClient` for `server`, wired to the shared
/// Keychain token store and to `session` for terminal-refresh handling.
///
/// Takes the resolved `AuthSession` instance rather than a resolver closure
/// so the escaping `onSignOut` closure captures only a `@MainActor`,
/// `Sendable` class — never a SwiftUI view.
@MainActor
func makeCloudHTTPClient(server: URL, session: AuthSession) -> AuthenticatedHTTPClient {
    AuthenticatedHTTPClient(
        server: server,
        urlSession: .shared,
        tokensProvider: { try? TokenStore.load(server: server) },
        // Save AND mirror to the File Provider extension's shared store on
        // every rotation, so a background extension never refreshes with a
        // superseded token (→ server reuse-detection → family revoked →
        // sign-out). See CloudTokenPersistence.
        onTokensRefreshed: { try CloudTokenPersistence.persistRotated($0, server: server) },
        // A request 401'd and its refresh was rejected — the refresh token
        // is dead. Drive the OBSERVABLE AuthSession to signed-out (which
        // also clears the Keychain) rather than clearing the Keychain alone.
        // The old clear-only behavior left `session.isSignedIn` stuck true,
        // so the next request passed the cold-start guards and fired with no
        // bearer → the server's "missing bearer" 401, and the sidebar never
        // surfaced a way back in. handleAuthExpired flips the state, so the
        // sidebar shows "Sign in" and stops dispatching tokenless requests.
        onSignOut: {
            Task { @MainActor in await session.handleAuthExpired() }
        },
        refreshExecutor: BackgroundExecution()
    )
}
