// SelfHostedCredentialStore.swift — Keychain-backed token storage for the
// self-hosted Maple API.
//
// Mirrors `SMBCredentialStore`: passwords (here: bearer tokens) live in
// `kSecClassGenericPassword`; the list of known server URLs is serialised to
// UserDefaults so the UI can enumerate them without a Keychain query per row.
//
// Service string: "app.justmaple.aperture.self-hosted"
// Account string: the URL's host (lower-cased; ports are ignored — one token
// per host is the contract).
//
// Failure modes are non-fatal — when Keychain returns nil (locked, removed,
// sandboxed-without-access), the UI should prompt the user to re-pair.

import Foundation
import Security

// MARK: - SelfHostedCredentialStore

/// Persistent bearer-token store for self-hosted Maple servers. Actor-
/// isolated so reads and writes cannot race each other.
public actor SelfHostedCredentialStore {
    public static let shared = SelfHostedCredentialStore()

    /// Service string used for all self-hosted credential queries.
    public static let service = "app.justmaple.aperture.self-hosted"

    /// UserDefaults key for the list of saved server URLs.
    private static let savedServersKey = "app.justmaple.aperture.self-hosted.savedServers"

    public init() {}

    // MARK: - Public API

    /// Persist a bearer token for a given server URL. Writes the token to
    /// Keychain and appends the URL to the saved-servers UserDefaults list.
    public func setToken(_ token: String, forServerURL url: URL) throws {
        guard let account = Self.accountKey(for: url) else { return }
        try Self.keychainSet(
            service: Self.service,
            account: account,
            password: token
        )
        var saved = Self.loadSavedServers()
        if !saved.contains(url) {
            saved.append(url)
            Self.writeSavedServers(saved)
        }
    }

    /// Fetch the bearer token previously stored for `url`. Returns `nil`
    /// when no token is on file (first-open, Keychain cleared, or locked).
    public func tokenForServerURL(_ url: URL) -> String? {
        guard let account = Self.accountKey(for: url) else { return nil }
        return Self.keychainGet(service: Self.service, account: account)
    }

    /// Remove the token for `url` from Keychain and drop the URL from the
    /// saved-servers list.
    public func removeToken(forServerURL url: URL) throws {
        guard let account = Self.accountKey(for: url) else { return }
        Self.keychainDelete(service: Self.service, account: account)
        var saved = Self.loadSavedServers()
        saved.removeAll { $0 == url }
        Self.writeSavedServers(saved)
    }

    /// Servers the user has paired with (URL list from UserDefaults).
    public func knownServers() -> [URL] {
        Self.loadSavedServers()
    }

    // MARK: - Back-compat shim (older API)
    //
    // The original in-memory store exposed an optional-token setter. Keep
    // the same shape so existing callers (AppShell pre-T5) still compile.
    public func setToken(_ token: String?, forServerURL url: URL) {
        if let token {
            try? setToken(token, forServerURL: url)
        } else {
            try? removeToken(forServerURL: url)
        }
    }

    public func token(forServerURL url: URL) -> String? {
        tokenForServerURL(url)
    }

    // MARK: - Keys

    private static func accountKey(for url: URL) -> String? {
        guard let host = url.host?.lowercased() else { return nil }
        return host
    }

    // MARK: - UserDefaults helpers

    private static func loadSavedServers() -> [URL] {
        guard let data = UserDefaults.standard.data(forKey: savedServersKey) else { return [] }
        guard let strings = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return strings.compactMap { URL(string: $0) }
    }

    private static func writeSavedServers(_ servers: [URL]) {
        let strings = servers.map { $0.absoluteString }
        if let data = try? JSONEncoder().encode(strings) {
            UserDefaults.standard.set(data, forKey: savedServersKey)
        }
    }

    // MARK: - Keychain primitives

    @discardableResult
    private static func keychainSet(service: String, account: String, password: String) throws -> Bool {
        guard let data = password.data(using: .utf8) else { return false }
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var addQuery = query
        addQuery[kSecValueData as String] = data
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status != errSecSuccess {
            throw SelfHostedCredentialStoreError.keychain(status: status)
        }
        return true
    }

    private static func keychainGet(service: String, account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String:  true,
            kSecMatchLimit as String:  kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func keychainDelete(service: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

// MARK: - Error

public enum SelfHostedCredentialStoreError: Error, LocalizedError, Equatable {
    case keychain(status: OSStatus)

    public var errorDescription: String? {
        switch self {
        case .keychain(let s): return "Keychain error (OSStatus \(s))"
        }
    }
}
