// PhotoKitLibrary.swift — Higher-level PhotoKit helpers used by the sidebar.
//
// `PhotoKitSource` is the stateful actor that fetches and holds the asset
// list. `PhotoKitLibrary` is a stateless facade the sidebar calls *before*
// any source has been selected — e.g. to decide whether to show the
// "Grant Photos access" row or the "All Photos / Favorites / Picks /
// Rejects / Albums" tree, and to enumerate the user's albums.
//
// Filter semantics live in `PhotoKitSource.fetchAssets(for:)`.

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
