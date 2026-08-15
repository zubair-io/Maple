// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderDomainController.swift
import Foundation
import FileProvider
import OSLog

public actor FileProviderDomainController {
    public enum EnableError: Error, LocalizedError {
        case invalidServerURL
        /// No usable auth token exists for the server being enabled. Thrown
        /// by `enable()` before any domain state is persisted — see #2540:
        /// previously this only logged a warning and still reported
        /// success, leaving the extension running unauthenticated with no
        /// signal to the user.
        case noAuthToken

        public var errorDescription: String? {
            switch self {
            case .invalidServerURL:
                return "That server URL isn't valid."
            case .noAuthToken:
                return "No signed-in account for this server. Sign in, then try enabling again."
            }
        }
    }

    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "domain")
    private let config: FileProviderConfig

    public init(config: FileProviderConfig = .init()) { self.config = config }

    /// Canonical domain identifier for a server URL. Includes the scheme
    /// (#2544) and the explicit port when present, so `http://host:3000`
    /// and `https://host:3000` — a realistic self-host lifecycle event,
    /// e.g. turning on TLS for an existing server — produce distinct File
    /// Provider domains instead of silently colliding on one domain and
    /// reusing its stale cached state under the new protocol. Returns nil
    /// for hostless URLs (file:// etc.). Dash separator — colons are
    /// reserved by `FileProviderIdentifier` for the `folder/<id>:<path>`
    /// form. A missing scheme defaults to "http", matching
    /// `LocalNetworkResolver`'s own default for an unscoped LAN report.
    ///
    /// Changing this algorithm changes domain IDENTITY for every already-
    /// installed domain — see `legacyDomainIdentifier(for:)` and
    /// `reconcile(validServerURLs:)`'s migration pass, which exists
    /// specifically so this change doesn't silently orphan an
    /// already-enabled File Sync domain the first time `reconcile` runs
    /// after upgrade.
    public nonisolated static func domainIdentifier(for serverURL: URL) -> String? {
        guard let host = serverURL.host, !host.isEmpty else { return nil }
        let scheme = serverURL.scheme ?? "http"
        if let port = serverURL.port {
            return "\(scheme)-\(host)-\(port)"
        }
        return "\(scheme)-\(host)"
    }

    /// The pre-#2544 domain identifier algorithm — scheme-blind, just
    /// host + port. Kept ONLY so `reconcile(validServerURLs:)` can
    /// recognise an already-installed legacy domain for a still-connected
    /// server and migrate it forward to the new scheme-aware identifier,
    /// rather than tearing it down as an orphan the moment `domainIdentifier(for:)`
    /// starts returning a different string for the exact same server.
    private nonisolated static func legacyDomainIdentifier(for serverURL: URL) -> String? {
        guard let host = serverURL.host, !host.isEmpty else { return nil }
        if let port = serverURL.port {
            return "\(host)-\(port)"
        }
        return host
    }

    public func enable(serverURL: URL, displayName: String) async throws -> NSFileProviderDomain {
        guard let idString = Self.domainIdentifier(for: serverURL) else { throw EnableError.invalidServerURL }
        // Gate the whole enable on a usable token BEFORE persisting any
        // config or registering the domain with the OS. Without this,
        // enable() reported success (and the Settings UI showed
        // "Enabled …") even when the extension had no way to authenticate,
        // so it would run — and silently fail every sync — until the next
        // sign-in (#2540).
        guard let tokens = (try? TokenStore.load(server: serverURL)) ?? nil,
              !tokens.access.isEmpty else {
            log.error("no usable app-wide token for \(serverURL.absoluteString, privacy: .public) — refusing to enable an unauthenticated domain")
            throw EnableError.noAuthToken
        }
        let identifier = NSFileProviderDomainIdentifier(idString)
        let domain = NSFileProviderDomain(identifier: identifier, displayName: displayName)
        config.save(.init(domainIdentifier: identifier.rawValue,
                          displayName: displayName,
                          serverURL: serverURL))
        do {
            try await NSFileProviderManager.add(domain)
        } catch {
            // Roll back the partial state so the user can retry cleanly.
            config.remove(domain: identifier.rawValue)
            log.error("NSFileProviderManager.add failed; rolled back config + tokens: \(error.localizedDescription, privacy: .public)")
            throw error
        }
        log.info("added domain \(identifier.rawValue, privacy: .public)")
        return domain
    }

    public func disable(domainIdentifier: String) async throws {
        let identifier = NSFileProviderDomainIdentifier(domainIdentifier)
        // Attempt the File Provider teardown, but DON'T let a throw here skip
        // the local cleanup below. If NSFileProviderManager is unavailable, the
        // domain registration may linger, but clearing the on-disk config +
        // mirrored tokens still stops the extension from reloading them and
        // polling a gone server — which is the "bad signature" loop we're
        // killing. The error is logged and rethrown so callers (e.g. the
        // settings UI) can still surface the failure.
        var teardownError: Error?
        do {
            let domains = try await NSFileProviderManager.domains()
            if let domain = domains.first(where: { $0.identifier == identifier }) {
                try await NSFileProviderManager.remove(domain)
            }
        } catch {
            teardownError = error
            log.error("NSFileProviderManager teardown failed for \(domainIdentifier, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
        config.remove(domain: domainIdentifier)
        log.info("cleared local state for domain \(domainIdentifier, privacy: .public)")
        if let teardownError { throw teardownError }
    }

    public func refresh(domainIdentifier: String) async throws {
        let identifier = NSFileProviderDomainIdentifier(domainIdentifier)
        let domains = try await NSFileProviderManager.domains()
        guard let domain = domains.first(where: { $0.identifier == identifier }),
              let mgr = NSFileProviderManager(for: domain) else { return }
        try await mgr.signalEnumerator(for: .rootContainer)
    }

    public func currentDomains() async throws -> [NSFileProviderDomain] {
        try await NSFileProviderManager.domains()
    }

    /// Tears down every File Provider domain that no longer corresponds to a
    /// connected server. Without this, removing a server from the sidebar on
    /// one launch (or an interrupted teardown) leaves an orphaned domain whose
    /// `<host>.json` config + mirrored tokens persist — the extension keeps
    /// reloading them and polling the gone/rebuilt server, surfacing as
    /// endless "bad signature" 401 loops that the UI offers no way to clear
    /// (the settings screen only lists domains for registered servers).
    ///
    /// `validServerURLs` is the authoritative set of connected servers
    /// (`CloudServerRegistry.servers`). Candidates are gathered from BOTH the
    /// registered NSFileProvider domains and the on-disk config files, so an
    /// orphan is cleaned up even if only one of the two survived a partial
    /// teardown. Returns the identifiers removed. Call at launch.
    @discardableResult
    public func reconcile(validServerURLs: [URL]) async -> [String] {
        let validIDs = Set(validServerURLs.compactMap { Self.domainIdentifier(for: $0) })
        var candidates = Set<String>()
        if let registered = try? await NSFileProviderManager.domains() {
            for d in registered { candidates.insert(d.identifier.rawValue) }
        }
        for c in config.allDomains() { candidates.insert(c.domainIdentifier) }

        // #2544 migration: a candidate matching the pre-#2544 scheme-blind
        // identifier for a URL that's STILL connected gets migrated to the
        // new scheme-aware identifier instead of torn down below as an
        // orphan. Without this, every already-enabled File Sync domain
        // would silently disable itself the first time reconcile() ran
        // after the identifier fix shipped — no user action, no signal,
        // just a Finder mount that quietly disappears. `migrated` is
        // excluded from the orphan set below regardless of outcome: a
        // successful migration already tore down the legacy id itself
        // (so it's no longer a candidate to re-examine), and a failed one
        // deliberately leaves the legacy id in place rather than deleting
        // the only surviving copy of the user's File Sync state.
        var migrated = Set<String>()
        for legacyID in candidates where !validIDs.contains(legacyID) {
            guard let match = validServerURLs.first(where: { Self.legacyDomainIdentifier(for: $0) == legacyID }),
                  let newID = Self.domainIdentifier(for: match),
                  !candidates.contains(newID) else { continue }
            await migrateLegacyDomain(legacyID: legacyID, newID: newID, serverURL: match)
            migrated.insert(legacyID)
        }

        let orphans = candidates.subtracting(validIDs).subtracting(migrated).sorted()
        for id in orphans {
            // `disable` clears local config + tokens even when it throws (the
            // throw means only the NSFileProviderManager registration may
            // linger), so the orphan's polling stops regardless. Log failures
            // so a stuck domain is diagnosable rather than silently retried.
            do {
                try await disable(domainIdentifier: id)
            } catch {
                log.error("reconcile: File Provider teardown failed for orphaned domain \(id, privacy: .public) (local state still cleared): \(error.localizedDescription, privacy: .public)")
            }
        }
        if !orphans.isEmpty {
            log.info("reconcile removed orphaned domains: \(orphans.joined(separator: ","), privacy: .public)")
        }
        return orphans
    }

    /// Migrates one legacy-identifier domain forward to its new
    /// scheme-aware identifier for the same server. Only tears down the
    /// legacy domain once the new one is confirmed installed — if
    /// `enable()` fails (no usable token anymore, OS registration error),
    /// the legacy domain is left exactly as it was, so a transient failure
    /// here never costs the user their only working copy of File Sync for
    /// this server. Safe to retry: the next `reconcile()` call (next
    /// launch) sees the same legacy candidate and tries again.
    private func migrateLegacyDomain(legacyID: String, newID: String, serverURL: URL) async {
        let displayName = config.load(domain: legacyID)?.displayName ?? serverURL.host ?? newID
        do {
            _ = try await enable(serverURL: serverURL, displayName: displayName)
        } catch {
            log.error("reconcile: #2544 migration \(legacyID, privacy: .public) -> \(newID, privacy: .public) failed, leaving legacy domain in place: \(error.localizedDescription, privacy: .public)")
            return
        }
        do {
            try await disable(domainIdentifier: legacyID)
        } catch {
            log.error("reconcile: #2544 migration teardown of legacy domain \(legacyID, privacy: .public) failed (new domain \(newID, privacy: .public) is already installed): \(error.localizedDescription, privacy: .public)")
        }
        log.info("reconcile: migrated domain \(legacyID, privacy: .public) -> \(newID, privacy: .public) for scheme-aware identity (#2544)")
    }

    /// Compatibility no-op for callers compiled around the former mirrored
    /// store. All processes now access `TokenStore`'s single shared item.
    public func mirrorTokens(serverURL: URL) {
        _ = serverURL
    }
}
