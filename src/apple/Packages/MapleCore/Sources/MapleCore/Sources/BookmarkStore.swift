// BookmarkStore.swift — persists and restores Security-Scoped Bookmark data so
// the app retains access to user-chosen folders across launches.
//
// Ported from the Maple reference (`Packages/MapleCore/Sources/MapleCore/
// Filesystem/BookmarkStore.swift`). Platform differences in the bookmark
// options are handled here so `FilesystemSource` stays clean:
//   • macOS: `.withSecurityScope`
//   • iOS:   `.minimalBookmark`
//
// Bookmarks are keyed by `url.absoluteString`, which is stable across launches
// for volumes mounted at the same mount point. Stale bookmarks are dropped on
// restore so the UI can present a re-pick prompt rather than silently failing.

import Foundation

public enum BookmarkError: Error, Sendable {
    case staleBookmark(URL)
    case creationFailed(URL)
    case permissionDenied(URL)
}

/// Persists and restores Security-Scoped Bookmark data so the app retains
/// access to user-chosen folders across launches.
public struct BookmarkStore: @unchecked Sendable {

    private static let defaultsKey = "app.justmaple.aperture.bookmarks"

    // UserDefaults is thread-safe but not annotated Sendable
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Save a security-scoped bookmark for the given URL.
    public func save(url: URL) throws {
        var bookmarks = loadRawBookmarks()

        #if os(macOS)
        let data = try url.bookmarkData(
            options: .withSecurityScope,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        #else
        let data = try url.bookmarkData(
            options: .minimalBookmark,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        #endif

        bookmarks[url.absoluteString] = data
        defaults.set(bookmarks.mapValues { $0 as Any }, forKey: Self.defaultsKey)
    }

    /// Restore all previously saved bookmarks. Returns resolved URLs.
    /// Stale bookmarks are removed automatically.
    public func restore() throws -> [URL] {
        let bookmarks = loadRawBookmarks()
        var resolved: [URL] = []
        var updated = bookmarks

        for (key, data) in bookmarks {
            var isStale = false
            do {
                #if os(macOS)
                let url = try URL(
                    resolvingBookmarkData: data,
                    options: .withSecurityScope,
                    relativeTo: nil,
                    bookmarkDataIsStale: &isStale
                )
                #else
                let url = try URL(
                    resolvingBookmarkData: data,
                    relativeTo: nil,
                    bookmarkDataIsStale: &isStale
                )
                #endif

                if isStale {
                    updated.removeValue(forKey: key)
                    continue
                }
                resolved.append(url)
            } catch {
                updated.removeValue(forKey: key)
            }
        }

        if updated.count != bookmarks.count {
            defaults.set(updated.mapValues { $0 as Any }, forKey: Self.defaultsKey)
        }

        return resolved
    }

    /// Resolve a single bookmark blob. Returns the scoped URL — caller is
    /// responsible for `startAccessingSecurityScopedResource` if it plans to
    /// hold scope for any meaningful duration.
    public static func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) {
        var isStale = false
        #if os(macOS)
        let url = try URL(
            resolvingBookmarkData: data,
            options: .withSecurityScope,
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        )
        #else
        let url = try URL(
            resolvingBookmarkData: data,
            options: [],
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        )
        #endif
        return (url, isStale)
    }

    /// Remove the bookmark for a specific URL.
    public func remove(url: URL) {
        var bookmarks = loadRawBookmarks()
        bookmarks.removeValue(forKey: url.absoluteString)
        defaults.set(bookmarks.mapValues { $0 as Any }, forKey: Self.defaultsKey)
    }

    // MARK: - Private

    private func loadRawBookmarks() -> [String: Data] {
        guard let dict = defaults.dictionary(forKey: Self.defaultsKey) else { return [:] }
        var result: [String: Data] = [:]
        for (key, value) in dict {
            if let data = value as? Data {
                result[key] = data
            }
        }
        return result
    }
}
