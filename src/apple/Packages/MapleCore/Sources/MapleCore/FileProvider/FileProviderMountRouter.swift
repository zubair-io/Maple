// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderMountRouter.swift
import Foundation

/// Decides whether a given Maple Cloud server should be read through the
/// File Provider mount (as a local folder, Mode 2) or through the server
/// API (Mode 1a).
///
/// This is the *only* per-server routing decision. Once `.folderView(URL)`
/// is returned, the caller drives the existing local-folder code path
/// (`AppShell.loadFolder(url:)`, `FilesystemSource`, `XMPSidecarStore`) —
/// it must NOT introduce any FP-specific read/write helper. The FP
/// extension is doing the API work on demand; the app just reads files.
///
/// Routing input:
///   1. Bookmark store (#100): `FileProviderMountBookmark.resolveURL(domain:)`
///      returns `(url, isStale)` when a persisted bookmark exists.
///   2. The OS-level scope claim must succeed on the resolved URL. A bookmark
///      that resolves but whose `startAccessingSecurityScopedResource()`
///      returns false is functionally stale — we fall back to API rather
///      than silently failing on the first read.
///
/// Falls back to `.apiServer(serverID)` when no bookmark is stored, when
/// resolution fails or reports `isStale`, or when the scope claim fails.
/// A `.staleBookmark` signal lets the caller surface "Sync access lost,
/// please re-grant" in Settings.
public enum FileProviderMountRouter {

    // MARK: - Decision

    /// Outcome of `resolve(serverURL:...)`.
    public enum Route: Equatable, Sendable {
        /// Use the existing Folder-View code path rooted at this URL.
        /// The URL is already a bookmark-resolved, scope-backed URL — the
        /// caller is responsible for `startAccessingSecurityScopedResource`
        /// over its lifetime.
        case folderView(URL)
        /// No usable bookmark; use the API code path against `serverID`.
        case apiServer(URL)
    }

    // MARK: - Inputs

    /// Resolver that converts a domain identifier into a (URL, isStale) pair.
    /// Defaults to `FileProviderMountBookmark.resolveURL`. Injectable so
    /// unit tests can return a synthetic plain-bookmark URL (which the
    /// production `.withSecurityScope` resolver rejects).
    public typealias Resolver = @Sendable (_ domain: String) -> (url: URL, isStale: Bool)?

    /// Scope-claim probe. Wraps `URL.startAccessingSecurityScopedResource`
    /// so tests can simulate the OS denying the claim. Production callers
    /// pass the default; the live claim is *idempotent* and the caller
    /// re-issues it for the session lifetime via `claimScope(for:)`.
    public typealias ScopeProbe = @Sendable (_ url: URL) -> Bool

    public static let defaultResolver: Resolver = { domain in
        FileProviderMountBookmark.resolveURL(domain: domain)
    }

    public static let defaultScopeProbe: ScopeProbe = { url in
        let ok = url.startAccessingSecurityScopedResource()
        // The router only PROBES — the caller will claim again for the
        // real session. Release immediately so the probe doesn't leak a
        // claim no one will release.
        if ok { url.stopAccessingSecurityScopedResource() }
        return ok
    }

    // MARK: - Public API

    /// Resolve the routing decision for one server. See the type comment for
    /// the order of fallbacks. Returns `.apiServer(serverURL)` whenever the
    /// bookmark cannot be used; never throws.
    public static func resolve(
        serverURL: URL,
        resolver: Resolver = defaultResolver,
        scopeProbe: ScopeProbe = defaultScopeProbe
    ) -> Route {
        guard let domain = FileProviderDomainController.domainIdentifier(for: serverURL) else {
            return .apiServer(serverURL)
        }
        guard let resolved = resolver(domain) else {
            // No bookmark stored (or bookmark resolution threw).
            return .apiServer(serverURL)
        }
        if resolved.isStale {
            return .apiServer(serverURL)
        }
        guard scopeProbe(resolved.url) else {
            // Bookmark resolved but the OS won't grant scoped access (the
            // bookmark target was moved, the entitlement is gone, etc.).
            return .apiServer(serverURL)
        }
        return .folderView(resolved.url)
    }

    /// True when a bookmark exists for `serverURL` AND it currently
    /// reports stale OR fails the scope probe. The Settings UI uses this
    /// signal to render "Sync access lost, please re-grant."
    public static func isBookmarkBroken(
        serverURL: URL,
        resolver: Resolver = defaultResolver,
        scopeProbe: ScopeProbe = defaultScopeProbe
    ) -> Bool {
        guard let domain = FileProviderDomainController.domainIdentifier(for: serverURL) else {
            return false
        }
        guard let resolved = resolver(domain) else {
            // No bookmark at all is not a "broken" state — it just means
            // the user hasn't granted access yet.
            return false
        }
        if resolved.isStale { return true }
        return !scopeProbe(resolved.url)
    }
}
