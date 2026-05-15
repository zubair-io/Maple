// PhotoKitLibrary.swift — Higher-level PhotoKit helpers used by the sidebar.
//
// `PhotoKitSource` is the stateful actor that fetches and holds the asset
// list. `PhotoKitLibrary` is a stateless facade the sidebar calls *before*
// any source has been selected — e.g. to decide whether to show the
// "Grant Photos access" row or the "All Photos / Favorites / Picks /
// Rejects / Albums" tree, and to enumerate the user's albums.
//
// Filter semantics live in `PhotoKitSource.fetchAssets(for:)`.
//
// `PhotoKitChangeObserver` is a process-wide singleton that registers as a
// `PHPhotoLibraryChangeObserver` and fans changes out to subscribers. Without
// it the sidebar's album list and the grid's fetch result go stale the first
// time the user adds a photo in another app — the working reference at
// `../Maple/.../PhotoKit/PhotoKitBridge.swift` registers the observer at
// PhotoKitSource init; we mirror that pattern here so the same fan-out is
// available to both the sidebar facade and the source actor.

import Foundation
import Photos

// MARK: - PhotoKitFilter

/// Which subset of the user's Photos library to surface in the grid.
public enum PhotoKitFilter: Sendable, Hashable, Codable {
    case all
    case favorites
    case picks          // maple:flag == .pick OR xmp:Rating >= 3 (applied by VM)
    case rejects        // maple:flag == .reject (applied by VM)
    case album(id: String, title: String)

    public var title: String {
        switch self {
        case .all:                 return "All Photos"
        case .favorites:           return "Favorites"
        case .picks:               return "Picks"
        case .rejects:             return "Rejects"
        case .album(_, let title): return title
        }
    }
}

// MARK: - PhotoKitAlbum

/// Lightweight album descriptor for the sidebar. `id` is the collection's
/// `localIdentifier` — stable across app launches.
public struct PhotoKitAlbum: Sendable, Hashable, Identifiable, Codable {
    public let id: String
    public let title: String
    public let count: Int

    public init(id: String, title: String, count: Int) {
        self.id = id
        self.title = title
        self.count = count
    }
}

// MARK: - PhotoKitLibrary

/// Read-only facade around the Photos framework. Sync methods — PhotoKit
/// exposes cache-backed APIs that return immediately without I/O.
public enum PhotoKitLibrary {

    public static func authorizationStatus() -> PHAuthorizationStatus {
        PHPhotoLibrary.authorizationStatus(for: .readWrite)
    }

    public static func requestAuthorization() async -> PHAuthorizationStatus {
        await PHPhotoLibrary.requestAuthorization(for: .readWrite)
    }

    /// Enumerate the user's albums (`PHAssetCollectionType.album`).
    /// Excludes smart albums and system collections so the sidebar only
    /// shows what the user explicitly created.
    public static func userAlbums() -> [PhotoKitAlbum] {
        let options = PHFetchOptions()
        let result = PHAssetCollection.fetchAssetCollections(
            with: .album, subtype: .any, options: options
        )
        var out: [PhotoKitAlbum] = []
        result.enumerateObjects { collection, _, _ in
            let title = collection.localizedTitle ?? "Untitled"
            let count = PHAsset.fetchAssets(in: collection, options: nil).count
            out.append(PhotoKitAlbum(
                id: collection.localIdentifier,
                title: title,
                count: count
            ))
        }
        return out
    }
}

// MARK: - PhotoKitChangeObserver

/// Process-wide PhotoKit change-observation singleton. PhotoKit only delivers
/// `photoLibraryDidChange` to objects that registered themselves via
/// `PHPhotoLibrary.shared().register(_:)` — the registration must happen on a
/// long-lived object, not on a transient actor that might get torn down
/// between a source switch and the change notification arriving. The
/// reference repo's `PhotoKitBridge` did this; we mirror the long-lived
/// observer pattern here as a singleton so the sidebar's album list and the
/// active source can both subscribe without each registering its own observer
/// (PhotoKit will silently drop a second registration of the same instance).
public final class PhotoKitChangeObserver: NSObject, PHPhotoLibraryChangeObserver, @unchecked Sendable {

    public static let shared = PhotoKitChangeObserver()

    private let lock = NSLock()
    private var subscribers: [UUID: @Sendable () -> Void] = [:]
    private var registered = false

    private override init() {
        super.init()
    }

    /// Subscribe to library-change notifications. The handler runs on a
    /// PhotoKit-private thread; subscribers must marshal to their own actor.
    /// Returns a token; pass it to `unsubscribe(_:)` to detach.
    @discardableResult
    public func subscribe(_ handler: @escaping @Sendable () -> Void) -> UUID {
        let token = UUID()
        lock.lock()
        subscribers[token] = handler
        let needRegister = !registered
        registered = true
        lock.unlock()
        if needRegister {
            // Register lazily — the first time anyone cares about library
            // changes. PhotoKit must see the same instance every time, so we
            // register `self` (the singleton) only once for the life of the
            // process. Subsequent register calls would no-op anyway.
            PHPhotoLibrary.shared().register(self)
        }
        return token
    }

    public func unsubscribe(_ token: UUID) {
        lock.lock()
        subscribers.removeValue(forKey: token)
        lock.unlock()
    }

    public func photoLibraryDidChange(_ changeInstance: PHChange) {
        lock.lock()
        let handlers = Array(subscribers.values)
        lock.unlock()
        for handler in handlers { handler() }
    }

    /// Fire a synthetic change notification to all current subscribers.
    /// For testing only — exercises the full fan-out path without a live
    /// Photos library. Handlers are called synchronously on the calling thread.
    internal func fireForTesting() {
        lock.lock()
        let handlers = Array(subscribers.values)
        lock.unlock()
        for handler in handlers { handler() }
    }
}
