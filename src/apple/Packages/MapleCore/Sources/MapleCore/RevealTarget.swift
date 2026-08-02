// RevealTarget.swift — where "reveal containing folder" should navigate for
// an asset (#2518). Pure derivation off `AssetRef` so the app-side action is
// a thin switch and the routing logic is unit-testable without SwiftUI.

import Foundation

/// The browse destination that contains an asset.
public enum RevealTarget: Equatable, Sendable {
    /// A Self-Hosted asset — open its cloud library at the parent directory.
    case cloud(serverID: URL, folderID: String, libraryPath: String)
    /// A local filesystem asset — open its parent directory in browse.
    case local(parent: URL)
    /// No revealable folder (e.g. a PhotoKit asset — no folder concept).
    case none
}

extension AssetRef {
    /// The containing-folder destination for this asset. Cloud assets reveal
    /// via their `catalog` (server + folder + parent of the abs path); local
    /// assets reveal via the parent of `primaryURL`; everything else is
    /// `.none` (the info pane then shows a non-clickable path, or no path).
    public var revealTarget: RevealTarget {
        if let catalog {
            let parent = (catalog.absPath as NSString).deletingLastPathComponent
            return .cloud(
                serverID: catalog.serverID,
                folderID: catalog.folderID,
                libraryPath: parent
            )
        }
        if let primaryURL {
            return .local(parent: primaryURL.deletingLastPathComponent())
        }
        return .none
    }

    /// Library-relative CONTAINING FOLDER for the info pane's clickable row —
    /// what the reveal action opens. Cloud assets derive it from the
    /// `slug:relPath` address (drop the filename, render as a path), e.g.
    /// "photos/2010/Family/Wedding" — NOT the server `/srv/…` abs path. Local
    /// assets use the parent directory's path. `nil` for PhotoKit (no folder).
    public var displayFolder: String? {
        if let catalog, let address = catalog.address {
            // address = "slug:relPath/filename".
            if let slash = address.lastIndex(of: "/") {
                // Drop the filename, then present "slug:relPath" as "slug/relPath".
                return address[..<slash].replacingOccurrences(of: ":", with: "/")
            }
            // No "/" → the file sits at the library root; show just the library.
            if let colon = address.firstIndex(of: ":") {
                return String(address[..<colon])
            }
            return address
        }
        return primaryURL?.deletingLastPathComponent().path
    }
}
