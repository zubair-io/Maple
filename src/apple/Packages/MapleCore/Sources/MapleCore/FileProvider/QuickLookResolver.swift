// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/QuickLookResolver.swift
import Foundation

public enum QuickLookResolver {
    /// Walks parent components of a Quick-Look-supplied file URL looking
    /// for a directory whose name matches a configured File Provider
    /// domain identifier. Returns the first match.
    ///
    /// As a fallback, if exactly one domain is configured, returns it
    /// unconditionally — this is the common case on a fresh install
    /// and matches the spec's primary user flow.
    public static func resolveDomain(from fileURL: URL,
                                     configured: Set<String>) -> String? {
        var url = fileURL.deletingLastPathComponent()
        while url.path != "/" {
            if configured.contains(url.lastPathComponent) {
                return url.lastPathComponent
            }
            let parent = url.deletingLastPathComponent()
            if parent.path == url.path { break }
            url = parent
        }
        if configured.count == 1, let only = configured.first {
            return only
        }
        return nil
    }
}
