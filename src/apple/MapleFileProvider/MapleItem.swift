// src/apple/MapleFileProvider/MapleItem.swift
import FileProvider
import MapleCore
import UniformTypeIdentifiers

final class MapleItem: NSObject, NSFileProviderItem {
    private let identifier: FileProviderIdentifier
    private let displayName: String
    private let isDirectory: Bool
    private let size: NSNumber?
    private let modified: Date?
    private let utType: UTType
    private let writeCapabilities: NSFileProviderItemCapabilities

    let itemIdentifier: NSFileProviderItemIdentifier
    let parentItemIdentifier: NSFileProviderItemIdentifier
    let filename: String
    var contentType: UTType { utType }
    var capabilities: NSFileProviderItemCapabilities { writeCapabilities }
    var documentSize: NSNumber? { size }
    var contentModificationDate: Date? { modified }
    var creationDate: Date? { modified }
    var itemVersion: NSFileProviderItemVersion {
        let mtimeBytes = String(Int(modified?.timeIntervalSince1970 ?? 0)).data(using: .utf8) ?? Data()
        return .init(contentVersion: mtimeBytes, metadataVersion: mtimeBytes)
    }
    var isUploaded: Bool { true }
    var isDownloaded: Bool { false }

    init(libraryRoot root: LibraryRoot) {
        self.identifier = .folder(folderID: root.id, relativePath: "")
        self.displayName = root.label
        self.isDirectory = true
        self.size = nil
        self.modified = nil
        self.utType = .folder
        self.writeCapabilities = [.allowsReading]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = .rootContainer
        self.filename = root.label
    }

    init(subdirectory dir: DirChild, parentFolderID: String, parentRelativePath: String, parentIdentifier: NSFileProviderItemIdentifier) {
        let child = parentRelativePath.isEmpty ? dir.name : "\(parentRelativePath)/\(dir.name)"
        self.identifier = .folder(folderID: parentFolderID, relativePath: child)
        self.displayName = dir.name
        self.isDirectory = true
        self.size = nil
        self.modified = dir.mtime
        self.utType = .folder
        self.writeCapabilities = [.allowsReading]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentIdentifier
        self.filename = dir.name
    }

    /// Returns nil for unindexed images (no asset ID).
    init?(image: ImageChild, parentIdentifier: NSFileProviderItemIdentifier) {
        guard let assetID = image.assetID, !assetID.isEmpty else { return nil }
        self.identifier = .asset(assetID)
        self.displayName = image.name
        self.isDirectory = false
        self.size = NSNumber(value: image.size)
        self.modified = image.mtime
        self.utType = UTType(filenameExtension: image.ext) ?? .data
        // RAWs remain read-only in Phase 2.
        self.writeCapabilities = [.allowsReading]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentIdentifier
        self.filename = image.name
    }

    /// Writable XMP sidecar. `parentImageBase` is the paired image's
    /// filename without its extension (e.g. "IMG_1" for "IMG_1.ARW");
    /// used to decide canonical vs. conflict-copy by comparing against
    /// the sidecar's on-disk name.
    /// Builds an item from an AssetListEntry returned by the working-set
    /// seeding queries. We don't have full metadata (no extension via the
    /// list endpoint — fall back to deriving from `filename`), so this is
    /// a lightweight placeholder. The OS uses the parent identifier
    /// (.workingSet) only as a routing hint; folder enumeration still
    /// re-attaches the item to its real container.
    init(workingSetEntry e: AssetListEntry) {
        self.identifier = .asset(e.id)
        self.displayName = e.filename
        self.isDirectory = false
        // The list endpoint doesn't carry size; that's OK — the OS will
        // fetch the real bytes on demand via fetchContents.
        self.size = nil
        // AssetListEntry.mtime is epoch seconds (matches the AssetDoc
        // schema's `mtime` field).
        self.modified = Date(timeIntervalSince1970: TimeInterval(e.mtime))
        let ext = (e.filename as NSString).pathExtension
        self.utType = UTType(filenameExtension: ext) ?? .data
        self.writeCapabilities = [.allowsReading]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = .workingSet
        self.filename = e.filename
    }

    /// Minimal item returned by enumerateChanges for non-delete events
    /// when we only have a cursor + assetID. The OS will call
    /// `item(for:)` to pick up real metadata; this stub exists so the
    /// itemVersion bumps and tells the OS to re-read.
    ///
    /// `parentItemIdentifier` stays `.workingSet` even when the
    /// `AssetChange` carries a `folderID`: a real folder-child
    /// identifier is `folder(folderID, relativePath)`, and the
    /// change-feed payload does NOT include the relative path. Routing
    /// the stub to `folder(folderID, "")` would point the OS at the
    /// folder ROOT — wrong parent for a nested asset, and worse than
    /// `.workingSet` which is at least always-valid. Follow-up: extend
    /// the change-feed payload with the asset's full relative path (or
    /// add a `GET /api/assets/:id` round-trip) so this stub can hand
    /// back a real folder parent.
    init(stubAssetID assetID: String, cursor: Int64) {
        self.identifier = .asset(assetID)
        self.displayName = "(stub)"
        self.isDirectory = false
        self.size = nil
        // Encode the cursor in the modified date so `itemVersion`
        // (which derives both content + metadata versions from
        // `modified.timeIntervalSince1970`) bumps on every delta. A
        // follow-up phase should add a per-asset metadata GET so
        // enumerateChanges can hand back real items in one round-trip.
        self.modified = Date(timeIntervalSince1970: TimeInterval(cursor))
        self.utType = .data
        self.writeCapabilities = [.allowsReading]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = .workingSet
        self.filename = "(stub)"
    }

    init(sidecar: SidecarChild, parentImageBase: String, parentIdentifier: NSFileProviderItemIdentifier) {
        let canonicalName = "\(parentImageBase).xmp"
        let isCanonical = sidecar.name.caseInsensitiveCompare(canonicalName) == .orderedSame
        let basenameWithoutExt: String? = {
            guard !isCanonical else { return nil }
            // Strip the .xmp extension case-insensitively so Windows-origin
            // `.XMP` files don't carry the extension into the identifier.
            if sidecar.name.lowercased().hasSuffix(".xmp") {
                return String(sidecar.name.dropLast(4))
            }
            return sidecar.name
        }()
        self.identifier = .sidecar(assetID: sidecar.assetID, conflictBasename: basenameWithoutExt)
        self.displayName = sidecar.name
        self.isDirectory = false
        self.size = NSNumber(value: sidecar.size)
        self.modified = sidecar.mtime
        self.utType = UTType(filenameExtension: "xmp") ?? .xml
        self.writeCapabilities = [.allowsReading, .allowsWriting, .allowsDeleting]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentIdentifier
        self.filename = sidecar.name
    }
}
