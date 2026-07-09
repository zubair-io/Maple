// CloudFoldersListing.swift
//
// Static helper that BackupSettingsView uses to fetch /api/folders for
// a given server URL. Mirrors the logic in AppShell.loadCloudFoldersFor(_:)
// but lives here so BackupSettingsView doesn't need AppShell's sessionFor
// closure injected into it.
//
// Auth path: TokenStore (Keychain) → AuthenticatedHTTPClient → CloudFoldersClient.
// Bootstraps token restore (bootstrapAndRestore) if the session isn't yet
// signed in, then throws if still unsigned (prompts caller to show "sign in
// via the sidebar" error text).

import Foundation
import MapleCore

@MainActor
enum CloudFoldersListing {

    /// Returns a ready-to-use `CloudFoldersClient` for `server`, restoring
    /// Keychain tokens if needed. Throws `NSError` with a user-facing
    /// message directing them to the Self Hosted tab when the server is
    /// not signed in.
    static func client(for server: URL) async throws -> CloudFoldersClient {
        // Use the same bootstrap-and-restore dance as AppShell so the
        // Keychain tokens are loaded before the first HTTP request.
        let session = AuthSession(server: server,
                                  client: AuthClient(server: server))
        if !session.isSignedIn { await session.bootstrapAndRestore() }
        guard session.isSignedIn else {
            throw NSError(
                domain: "CloudFoldersListing",
                code: 401,
                userInfo: [NSLocalizedDescriptionKey:
                    "Not signed in to \(server.host ?? server.absoluteString). Sign in via the Cloud tab."]
            )
        }
        let httpClient = makeHTTPClient(server: server)
        let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: server)
        return CloudFoldersClient(server: effectiveServer, httpClient: httpClient)
    }

    // MARK: - Private

    /// Constructs an AuthenticatedHTTPClient backed by TokenStore, matching
    /// AppShell.makeAuthenticatedHTTPClient(server:) exactly.
    private static func makeHTTPClient(server: URL) -> AuthenticatedHTTPClient {
        AuthenticatedHTTPClient(
            server: server,
            urlSession: .shared,
            tokensProvider: { try? TokenStore.load(server: server) },
            // Mirror rotations into the File Provider store too — see CloudTokenPersistence.
            onTokensRefreshed: { CloudTokenPersistence.persistRotated($0, server: server) },
            onSignOut: { CloudTokenPersistence.clear(server: server) }
        )
    }
}
