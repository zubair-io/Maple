// SavedFolderStore.swift — UserDefaults-backed list of recently-opened local
// folders, plus their security-scoped bookmarks.
//
// The sidebar's "Folders" section lists up to 10 folders. Recency decides
// which folders are kept (opening one bumps it in and LRU-evicts the oldest),
// but they are displayed in stable alphabetical order rather than by recency.
// Opening one reuses the stored bookmark to reclaim security scope across
// launches without re-prompting the user.
//
// Passwords and other secrets do not appear here — bookmarks are opaque
// handles, not credentials. Keychain remains the home for SMB + self-hosted
// tokens.

import Foundation

// MARK: - SavedFolder

/// A local folder the user has opened in the past. The bookmark is a
/// security-scoped `URL.BookmarkData` blob produced by `FilesystemSource`
/// at open time.
public struct SavedFolder: Sendable, Hashable, Codable, Identifiable {
    /// Stable identity — the bookmark path derived at decode time. Kept as a
    /// string (not a URL) so equality works even for volumes that mount at
    /// different paths between sessions.
    public var id: String { path }

    /// Human-readable absolute path. Used for display + as the id.
    public let path: String

    /// Last path component — the folder name the UI shows.
    public let displayName: String

    /// Security-scoped bookmark. Pass to `FilesystemSource.restore(fromBookmarkData:)`.
    public let bookmark: Data

    /// Wall-clock time this entry was last opened. Used for LRU eviction.
    public let lastOpened: Date

    public init(path: String, displayName: String, bookmark: Data, lastOpened: Date) {
        self.path = path
        self.displayName = displayName
        self.bookmark = bookmark
        self.lastOpened = lastOpened
    }
}

// MARK: - SavedFolderStore

/// Static facade over `UserDefaults` for the list of recently-opened folders.
///
/// Capacity: 10. Oldest entries are evicted when a new folder pushes over the
/// cap. The store is thread-safe by virtue of UserDefaults being thread-safe;
/// no actor isolation is necessary.
public enum SavedFolderStore {
    public static let capacity = 10
    private static let key = "app.justmaple.aperture.savedFolders"

    /// Posted on every mutation so views caching a `load()` snapshot can
    /// refresh. Observers (e.g. the LibrarySidebar) should subscribe via
    /// `NotificationCenter.default.publisher(for: .savedFoldersChanged)`.
    public static let changedNotification = Notification.Name("SavedFolderStore.changed")

    public static func load(from defaults: UserDefaults = .standard) -> [SavedFolder] {
        guard let data = defaults.data(forKey: key) else { return [] }
        let folders = (try? JSONDecoder().decode([SavedFolder].self, from: data)) ?? []
        // Display order is alphabetical (Finder-standard, case-insensitive,
        // numeric-aware) so the sidebar stays stable across opens. Recency is
        // preserved in `lastOpened` and only drives capacity eviction in `upsert`.
        return folders.sorted {
            $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending
        }
    }

    /// The most-recently-opened folder, or `nil` if none are saved. `load()`
    /// is sorted alphabetically for stable sidebar display, so callers that
    /// want "the folder the user last had open" (e.g. the cold-start fallback
    /// in `autoPickInitialSource`) must use this — recency lives in
    /// `lastOpened`, not in `load()`'s order.
    public static func mostRecent(from defaults: UserDefaults = .standard) -> SavedFolder? {
        load(from: defaults).max { $0.lastOpened < $1.lastOpened }
    }

    /// Insert or refresh an entry. If a folder with the same `path` already
    /// exists it's replaced (updating the bookmark + lastOpened timestamp).
    /// LRU-evicts to `capacity` on overflow — the least-recently-opened entries
    /// are dropped (eviction tracks `lastOpened`, independent of display order).
    public static func upsert(_ folder: SavedFolder, into defaults: UserDefaults = .standard) {
        let others = load(from: defaults).filter { $0.path != folder.path }
        let combined = [folder] + others
        let kept =
            combined.count > capacity
            ? Array(combined.sorted { $0.lastOpened > $1.lastOpened }.prefix(capacity))
            : combined
        write(kept, to: defaults)
        notifyChanged()
    }

    public static func remove(path: String, from defaults: UserDefaults = .standard) {
        let remaining = load(from: defaults).filter { $0.path != path }
        write(remaining, to: defaults)
        notifyChanged()
    }

    public static func clear(from defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
        notifyChanged()
    }

    private static func write(_ folders: [SavedFolder], to defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(folders) else { return }
        defaults.set(data, forKey: key)
    }

    private static func notifyChanged() {
        // Hop to the main thread — notification observers in SwiftUI expect it.
        if Thread.isMainThread {
            NotificationCenter.default.post(name: changedNotification, object: nil)
        } else {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: changedNotification, object: nil)
            }
        }
    }
}
