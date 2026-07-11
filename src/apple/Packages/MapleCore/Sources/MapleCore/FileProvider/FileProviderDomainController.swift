// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderDomainController.swift
import Foundation
import FileProvider
import OSLog

public actor FileProviderDomainController {
    public enum EnableError: Error { case invalidServerURL }

    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "domain")
    private let config: FileProviderConfig

    public init(config: FileProviderConfig = .init()) { self.config = config }

    /// Canonical domain identifier for a server URL. Includes the explicit
    /// port when present so `http://localhost:3000` and `http://localhost:4000`
    /// produce distinct File Provider domains. Returns nil for hostless URLs
    /// (file:// etc.). Dash separator — colons are reserved by
    /// `FileProviderIdentifier` for the `folder/<id>:<path>` form.
    public nonisolated static func domainIdentifier(for serverURL: URL) -> String? {
        guard let host = serverURL.host, !host.isEmpty else { return nil }
        if let port = serverURL.port {
            return "\(host)-\(port)"
        }
        return host
    }

    public func enable(serverURL: URL, displayName: String) async throws -> NSFileProviderDomain {
        guard let idString = Self.domainIdentifier(for: serverURL) else { throw EnableError.invalidServerURL }
        let identifier = NSFileProviderDomainIdentifier(idString)
        let domain = NSFileProviderDomain(identifier: identifier, displayName: displayName)
        config.save(.init(domainIdentifier: identifier.rawValue,
                          displayName: displayName,
                          serverURL: serverURL))
        if ((try? TokenStore.load(server: serverURL)) ?? nil) == nil {
            log.warning("no app-wide tokens found for \(serverURL.absoluteString, privacy: .public) — extension will be unauthenticated until next sign-in")
        }
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
        let orphans = candidates.subtracting(validIDs).sorted()
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

    /// Compatibility no-op for callers compiled around the former mirrored
    /// store. All processes now access `TokenStore`'s single shared item.
    public func mirrorTokens(serverURL: URL) {
        _ = serverURL
    }
}
