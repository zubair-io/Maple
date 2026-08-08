// CloudDropEligibility.swift — the same-library guard for a Cloud
// drag-onto-source-tree drop (#2646 / #2725).
//
// `POST /api/assets/:id/relocate` resolves `destination_path` against the
// ASSET'S OWN library root — `relocate-asset.ts`'s `libRoot` is looked up
// from the asset's `fileinfo.library_id`, never from anything the client
// sends — so the endpoint has no way to express "move into a DIFFERENT
// library" at all. Without this guard, dragging an asset from Library A's
// grid onto a folder in Library B's tree (same server) would compute a
// destination path relative to Library B's root and post it; the server
// would silently resolve that path against Library A instead, landing the
// file at a Library-B-shaped path inside Library A while reporting
// success. This must be caught client-side before any request goes out.
//
// A tiny, pure, MapleCore-level function (rather than inlined directly in
// `AppShell+AssetDrop.swift`) specifically so it's covered by the
// `swift test` suite that actually runs in CI — the Xcode app target's own
// test target is a stub (see CLAUDE.md's Apple build section), so logic
// that needs real test coverage belongs in MapleCore.

import Foundation

public enum CloudDropEligibility {
    /// `true` when the dragged asset's own library (`AssetRef.catalog?.
    /// folderID`) matches the drop destination's library
    /// (`AssetDropDestination.cloud`'s `libraryFolderID`) — the only case
    /// `relocateAsset` can express. Server identity (host) is validated
    /// separately by the caller; this only covers same-server,
    /// cross-library drops.
    public static func isSameLibrary(assetLibraryFolderID: String, destinationLibraryFolderID: String) -> Bool {
        assetLibraryFolderID == destinationLibraryFolderID
    }
}
