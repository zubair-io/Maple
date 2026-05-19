// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderMountBookmark.swift
import Foundation
import OSLog

private let bookmarkLogger = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "mount-bookmark")

/// Per-domain security-scoped bookmark store for the user-granted
/// File Provider mount URL.
///
/// Persisted in App Group `UserDefaults` (`group.app.justmaple.aperture`)
/// keyed by `fileprovider.mount-bookmark.<domain>`. Unlike
/// `FileProviderConfig` — which moved off `UserDefaults(suiteName:)` to
/// file-based storage because the FP extension reads it from a different
/// sandbox and cfprefsd rejects `kCFPreferencesAnyUser + container` from
/// non-sandboxed clients — the bookmark only needs to be read by the
/// sandboxed host app, so UserDefaults is the simplest fit.
///
/// Callers are responsible for:
///   1. Generating the bookmark via
///      `url.bookmarkData(options: .withSecurityScope, ...)` after a
///      successful `NSOpenPanel`.
///   2. Calling `url.startAccessingSecurityScopedResource()` /
///      `stopAccessingSecurityScopedResource()` around any file I/O.
///   3. Re-prompting the user if `resolveURL` reports `isStale == true`.
public enum FileProviderMountBookmark {
    public static let suiteName = FileProviderConfig.appGroupSuiteName
    public static let keyPrefix = "fileprovider.mount-bookmark."

    /// Default UserDefaults used when no override is supplied. Falls back
    /// to `.standard` if the App Group entitlement isn't available — the
    /// degraded path matches `FileProviderConfig`'s "fall back, log, keep
    /// running" stance.
    public static var defaultDefaults: UserDefaults {
        UserDefaults(suiteName: suiteName) ?? .standard
    }

    private static func key(forDomain domain: String) -> String {
        keyPrefix + domain
    }

    /// Persist a security-scoped bookmark for a domain.
    public static func save(
        _ bookmark: Data,
        domain: String,
        defaults: UserDefaults = defaultDefaults
    ) {
        defaults.set(bookmark, forKey: key(forDomain: domain))
        bookmarkLogger.notice("saved bookmark for domain \(domain, privacy: .public) bytes=\(bookmark.count, privacy: .public)")
    }

    /// Load a previously-saved bookmark, or `nil` if none is persisted.
    public static func load(
        domain: String,
        defaults: UserDefaults = defaultDefaults
    ) -> Data? {
        defaults.data(forKey: key(forDomain: domain))
    }

    /// Clear a saved bookmark — used by the "Revoke access" UI path.
    public static func remove(
        domain: String,
        defaults: UserDefaults = defaultDefaults
    ) {
        defaults.removeObject(forKey: key(forDomain: domain))
        bookmarkLogger.notice("removed bookmark for domain \(domain, privacy: .public)")
    }

    /// Resolve a saved bookmark into a URL + stale flag.
    ///
    /// Returns `nil` when no bookmark is persisted, or when resolution
    /// throws (corrupted data, deleted target, etc.). `isStale == true`
    /// means the bookmark is still resolvable but the OS recommends
    /// re-creating it — the caller should re-prompt the user.
    public static func resolveURL(
        domain: String,
        defaults: UserDefaults = defaultDefaults
    ) -> (url: URL, isStale: Bool)? {
        guard let data = load(domain: domain, defaults: defaults) else { return nil }
        var isStale = false
        do {
            #if os(macOS)
            let options: URL.BookmarkResolutionOptions = [.withSecurityScope]
            #else
            let options: URL.BookmarkResolutionOptions = []
            #endif
            let url = try URL(
                resolvingBookmarkData: data,
                options: options,
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            return (url, isStale)
        } catch {
            bookmarkLogger.error("resolve failed for domain \(domain, privacy: .public): \(String(describing: error), privacy: .public)")
            return nil
        }
    }
}
