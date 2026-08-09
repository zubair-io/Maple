// TrashedItem.swift — one entry in a `.maple/trash`-backed source's trash
// (issue #2653). Shared model for the Local (iOS/iPadOS) and SMB engines'
// list/restore/purge surfaces, and for the in-app Trash browsing UI. macOS
// Filesystem sources have no equivalent — see `LocalFileOperations+Trash
// .swift`'s file header for why they route to the real OS Trash instead and
// never produce one of these.

import Foundation

public struct TrashedItem: Identifiable, Sendable, Equatable {
    /// The trashed primary file's own path (a local `URL.path` or an SMB
    /// share-relative path) — stable for the lifetime of this trash entry,
    /// since nothing renames a trashed item in place.
    public let id: String
    public let primaryPath: String
    public let sidecarPath: String?
    /// Path relative to the library root / share root BEFORE the item was
    /// trashed — the display name and Restore's target both derive from
    /// this (its last path component is the original filename).
    public let originalRelativePath: String
    /// When the trashed-date marker says this item was trashed. `nil` for a
    /// legacy item trashed before the marker scheme existed (or if writing
    /// the marker itself failed) — `sweepExpiredMapleTrash` deliberately
    /// never purges an item with no known trash date rather than guessing.
    public let trashedDate: Date?
    public let size: Int64

    public init(
        id: String, primaryPath: String, sidecarPath: String?,
        originalRelativePath: String, trashedDate: Date?, size: Int64
    ) {
        self.id = id
        self.primaryPath = primaryPath
        self.sidecarPath = sidecarPath
        self.originalRelativePath = originalRelativePath
        self.trashedDate = trashedDate
        self.size = size
    }

    /// The original filename — the last path component of
    /// `originalRelativePath` — for display in the Trash browser.
    public var displayName: String {
        (originalRelativePath as NSString).lastPathComponent
    }
}
