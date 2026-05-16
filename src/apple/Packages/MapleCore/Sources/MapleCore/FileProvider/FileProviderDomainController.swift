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
        let tokensStore = FileProviderTokensStore()
        if let tokens = (try? TokenStore.load(server: serverURL)) ?? nil {
            tokensStore.save(tokens, domain: identifier.rawValue)
        } else {
            log.warning("no app-wide tokens found for \(serverURL.absoluteString, privacy: .public) — extension will be unauthenticated until next sign-in")
        }
        do {
            try await NSFileProviderManager.add(domain)
        } catch {
            // Roll back the partial state so the user can retry cleanly.
            config.remove(domain: identifier.rawValue)
            tokensStore.remove(domain: identifier.rawValue)
            log.error("NSFileProviderManager.add failed; rolled back config + tokens: \(error.localizedDescription, privacy: .public)")
            throw error
        }
        log.info("added domain \(identifier.rawValue, privacy: .public)")
        return domain
    }

    public func disable(domainIdentifier: String) async throws {
        let identifier = NSFileProviderDomainIdentifier(domainIdentifier)
        let domains = try await NSFileProviderManager.domains()
        if let domain = domains.first(where: { $0.identifier == identifier }) {
            try await NSFileProviderManager.remove(domain)
        }
        config.remove(domain: domainIdentifier)
        FileProviderTokensStore().remove(domain: domainIdentifier)
        log.info("removed domain \(domainIdentifier, privacy: .public)")
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

    /// Mirrors tokens from the app-wide `TokenStore` into the shared
    /// `FileProviderTokensStore` for any registered domain matching `serverURL`.
    /// No-op if no domain is registered for that URL.
    /// Call this on sign-in and on every main-app token refresh so the
    /// extension stays authenticated. (Extension-initiated refreshes are not
    /// mirrored back — the user re-signs-in to recover after that edge case.)
    public func mirrorTokens(serverURL: URL) {
        guard let domainID = Self.domainIdentifier(for: serverURL) else { return }
        guard config.load(domain: domainID) != nil else { return }
        let tokensStore = FileProviderTokensStore()
        if let tokens = (try? TokenStore.load(server: serverURL)) ?? nil {
            tokensStore.save(tokens, domain: domainID)
            log.info("mirrored tokens for domain \(domainID, privacy: .public)")
        } else {
            tokensStore.remove(domain: domainID)
            log.info("cleared mirrored tokens for domain \(domainID, privacy: .public)")
        }
    }
}
