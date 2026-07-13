// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/MapleItem.swift
import FileProvider
import UniformTypeIdentifiers

public final class MapleItem: NSObject, NSFileProviderItem {
    private let identifier: FileProviderIdentifier
    private let displayName: String
    private let isDirectory: Bool
    private let size: NSNumber?
    private let modified: Date?
    private let utType: UTType
    private let writeCapabilities: NSFileProviderItemCapabilities

    public let itemIdentifier: NSFileProviderItemIdentifier
    public let parentItemIdentifier: NSFileProviderItemIdentifier
    public let filename: String
    public var contentType: UTType { utType }
    public var capabilities: NSFileProviderItemCapabilities { writeCapabilities }
    public var documentSize: NSNumber? { size }
    public var contentModificationDate: Date? { modified }
    public var creationDate: Date? { modified }
    public var itemVersion: NSFileProviderItemVersion {
        // macOS rejects zero-length version bytes with the cryptic
        // __FILEPROVIDER_BAD_ITEM_MISSING_ITEMVERSION__ abort. Compose a
        // version that's guaranteed non-empty for every item — items
        // without a server mtime (library roots, trash containers,
        // synthetic stubs) get the identifier itself as their version,
        // which is stable as long as the item exists.
        //
        // FORMAT: "<mtimeEpoch>-<identifier>" when we have a server mtime,
        // "v1-<identifier>" otherwise. The mtime prefix is load-bearing:
        // `modifyItem` decodes it via `decodePriorMtime` and forwards it
        // to the server as the `ifMtimeMatches` precondition for XMP
        // writes. A decoder that can't see the mtime would silently
        // disable conflict detection.
        let seed: String
        if let modified {
            seed = "\(Int(modified.timeIntervalSince1970))-\(identifier.rawValue)"
        } else {
            seed = "v1-\(identifier.rawValue)"
        }
        let bytes = Data(seed.utf8)
        return .init(contentVersion: bytes, metadataVersion: bytes)
    }

    /// Inverse of the `itemVersion` encoder. Reads the leading "<epoch>-"
    /// segment back out of a content-version blob. Returns nil for blobs
    /// without a numeric prefix ("v1-…" stubs, or zero/negative epochs).
    ///
    /// Used by `FileProviderExtensionCore.modifyItem` to populate the XMP
    /// write precondition. The split-before-`-` shape tolerates the
    /// post-Phase-5 format change that appended `<identifier>` to the
    /// seed; the prior `Int(s)` decode parsed the entire blob and
    /// returned nil for every non-pure-int payload, silently disabling
    /// conflict detection.
    public static func decodePriorMtime(_ contentVersion: Data) -> Date? {
        guard let s = String(data: contentVersion, encoding: .utf8) else { return nil }
        let prefix = s.split(separator: "-", maxSplits: 1,
                             omittingEmptySubsequences: false).first.map(String.init) ?? ""
        guard let epoch = Int(prefix), epoch > 0 else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(epoch))
    }
    public var isUploaded: Bool { true }
    public var isDownloaded: Bool { false }

    public init(libraryRoot root: LibraryRoot) {
        self.identifier = .folder(folderID: root.id, relativePath: "")
        self.displayName = root.label
        self.isDirectory = true
        self.size = nil
        self.modified = nil
        self.utType = .folder
        // `.allowsAddingSubItems` is required for Finder to offer the
        // drag-in upload affordance. Without it the Phase 3 createItem
        // path never fires for the library root.
        self.writeCapabilities = [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = .rootContainer
        self.filename = root.label
    }

    public init(subdirectory dir: DirChild, parentFolderID: String, parentRelativePath: String, parentIdentifier: NSFileProviderItemIdentifier) {
        let child = parentRelativePath.isEmpty ? dir.name : "\(parentRelativePath)/\(dir.name)"
        self.identifier = .folder(folderID: parentFolderID, relativePath: child)
        self.displayName = dir.name
        self.isDirectory = true
        self.size = nil
        self.modified = dir.mtime
        self.utType = .folder
        // Subdirectories inside a library must also accept drag-in
        // uploads (Phase 3) — same as the library root.
        self.writeCapabilities = [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentIdentifier
        self.filename = dir.name
    }

    /// Returns nil for unindexed images (no asset ID).
    public init?(image: ImageChild, parentIdentifier: NSFileProviderItemIdentifier) {
        guard let assetID = image.assetID, !assetID.isEmpty else { return nil }
        self.identifier = .asset(assetID)
        self.displayName = image.name
        self.isDirectory = false
        self.size = NSNumber(value: image.size)
        self.modified = image.mtime
        self.utType = UTType(filenameExtension: image.ext) ?? .data
        // Phase 3: live images allow drag-to-trash (Finder needs
        // `.allowsDeleting` to surface the action). RAWs remain
        // otherwise read-only — no in-place writes (.allowsWriting),
        // no rename (.allowsRenaming), no reparenting at this time.
        self.writeCapabilities = [.allowsReading, .allowsDeleting]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentIdentifier
        self.filename = image.name
    }

    /// A non-indexed file (video, document, extensionless, …). Stored +
    /// synced but has no `AssetDoc`, so it's addressed by
    /// `.file(folderID:relativePath:)` rather than an asset id.
    /// `relativePath` is the file relative to its library root.
    ///
    /// v1 capabilities are read-only (`.allowsReading`): the bytes
    /// download on demand, but in-place edit / rename / reparent / delete
    /// are deferred — those need a path-addressed mutate endpoint (the
    /// asset-id delete/trash machinery doesn't cover docless files).
    public init(file: FileChild, folderID: String, relativePath: String,
                parentIdentifier: NSFileProviderItemIdentifier) {
        self.identifier = .file(folderID: folderID, relativePath: relativePath)
        self.displayName = file.name
        self.isDirectory = false
        self.size = NSNumber(value: file.size)
        self.modified = file.mtime
        self.utType = file.ext.isEmpty ? .data : (UTType(filenameExtension: file.ext) ?? .data)
        self.writeCapabilities = [.allowsReading]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentIdentifier
        self.filename = file.name
    }

    /// Synthetic Trash container shown at the root of each library.
    /// The identifier is `trash/<folderID>` so the extension can route
    /// `enumerator(for:)` to a `TrashEnumerator` and decide capabilities.
    public init(trashContainer folderID: String, displayName: String) {
        self.identifier = .trash(folderID: folderID)
        self.displayName = displayName
        self.isDirectory = true
        self.size = nil
        self.modified = nil
        self.utType = .folder
        // Trash itself is read-only as a container — items inside it
        // can be moved out (restore) or deleted (permanent purge).
        // `.allowsContentEnumerating` is required for Finder to call
        // `enumerator(for:)` on it (which routes to TrashEnumerator).
        // We deliberately do NOT include `.allowsAddingSubItems` —
        // uploads into Trash are not supported.
        self.writeCapabilities = [.allowsReading, .allowsContentEnumerating]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = .rootContainer
        self.filename = displayName
    }

    /// Trashed asset surfaced inside the Trash container. Keeps the same
    /// `asset/<id>` identifier as the live item so identity is stable
    /// across delete/restore (per spec — server-side identifiers).
    /// Capabilities allow reading (lazy materialization still works on
    /// trashed files), reparenting (drag back out of Trash to restore),
    /// and deleting (drag inside trash → permanent purge).
    public init(trashed item: TrashItem, parentTrashIdentifier: NSFileProviderItemIdentifier) {
        self.identifier = .asset(item.assetID)
        self.displayName = item.filename
        self.isDirectory = false
        self.size = NSNumber(value: item.size)
        self.modified = item.deletedAt
        self.utType = UTType(filenameExtension: (item.filename as NSString).pathExtension) ?? .data
        self.writeCapabilities = [.allowsReading, .allowsReparenting, .allowsDeleting]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentTrashIdentifier
        self.filename = item.filename
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
    public init(workingSetEntry e: AssetListEntry, parent: NSFileProviderItemIdentifier = .workingSet) {
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
        self.parentItemIdentifier = parent
        self.filename = e.filename
    }

    /// Built from a single-asset metadata fetch (`GET /api/assets/:id`).
    /// Used by `FileProviderExtension.item(for:)` when the OS resolves
    /// a bare `.asset(id)` identifier (typically delivered through
    /// `enumerateChanges`). Carries real filename / mtime / size, so the
    /// OS gets the canonical content version on the first lookup.
    /// `parentItemIdentifier` is `.workingSet` — the asset's true folder
    /// parent would be `folder(folderID, relativePath)`, but the API
    /// endpoint doesn't yet expose `relativePath`. Routing to the
    /// folder root would point at the wrong directory; `.workingSet`
    /// is always-valid and the OS reattaches on folder enumeration.
    public init(assetMetadata m: AssetMetadata, parent: NSFileProviderItemIdentifier = .workingSet) {
        self.identifier = .asset(m.id)
        self.displayName = m.filename
        self.isDirectory = false
        self.size = NSNumber(value: m.size)
        self.modified = m.contentModificationDate
        let ext = (m.filename as NSString).pathExtension
        self.utType = UTType(filenameExtension: ext) ?? .data
        self.writeCapabilities = [.allowsReading]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parent
        self.filename = m.filename
    }

    /// Minimal item returned by enumerateChanges for non-delete events
    /// when we only have a cursor + assetID. The OS will call
    /// `item(for:)` to pick up real metadata; this stub exists so the
    /// itemVersion bumps and tells the OS to re-read.
    ///
    /// `parentItemIdentifier` is derived from `folderID + relativePath`
    /// when both are present (Phase 6 item 2): the change-feed payload
    /// now carries the asset's path relative to its folder root, so we
    /// can attach the stub under `folder(folderID, dirname(relPath))`
    /// instead of `.workingSet`. Falls back to `.workingSet` when
    /// either is nil — legacy server payloads, or rows where the
    /// server couldn't reconcile absPath against folder.path. The
    /// `.workingSet` parent is always-valid; the OS reattaches under
    /// the real folder on the next folder enumeration regardless.
    ///
    /// `filename` falls back to `lastPathComponent(relativePath)` when
    /// available — saves Finder from briefly painting "(stub)" before
    /// `item(for:)` resolves the full metadata.
    public init(stubAssetID assetID: String,
                cursor: Int64,
                folderID: String? = nil,
                relativePath: String? = nil) {
        self.identifier = .asset(assetID)
        let resolvedFilename: String = {
            guard let rel = relativePath, !rel.isEmpty else { return "(stub)" }
            let last = (rel as NSString).lastPathComponent
            return last.isEmpty ? "(stub)" : last
        }()
        self.displayName = resolvedFilename
        self.isDirectory = false
        self.size = nil
        // Encode the cursor in the modified date so `itemVersion`
        // (which derives both content + metadata versions from
        // `modified.timeIntervalSince1970`) bumps on every delta. A
        // follow-up phase should add a per-asset metadata GET so
        // enumerateChanges can hand back real items in one round-trip.
        self.modified = Date(timeIntervalSince1970: TimeInterval(cursor))
        // Extension is derived from the resolved filename so Quick
        // Look's "spacebar shows the right icon" affordance kicks in
        // before `item(for:)` fills in the rest.
        let ext = (resolvedFilename as NSString).pathExtension
        self.utType = ext.isEmpty ? .data : (UTType(filenameExtension: ext) ?? .data)
        self.writeCapabilities = [.allowsReading]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        if let folderID, let rel = relativePath {
            // Parent dir relative to the folder root. `lastPathComponent`
            // of `relativePath` is the filename; `deletingLastPathComponent`
            // gives the dir. Both for a root-level asset reduce to `""`,
            // which is the folder-root identifier (`folder(folderID, "")`).
            let parentRel = (rel as NSString).deletingLastPathComponent
            let parent = FileProviderIdentifier.folder(folderID: folderID,
                                                       relativePath: parentRel)
            self.parentItemIdentifier = NSFileProviderItemIdentifier(parent.rawValue)
        } else {
            self.parentItemIdentifier = .workingSet
        }
        self.filename = resolvedFilename
    }

    /// Synthetic `.maple/` directory surfaced under every enumerable
    /// folder. The server hides this dir from `/api/fs/dir` (dotdir
    /// filter); the FP extension synthesizes it client-side so the
    /// app's future Folder-View consumer (#101) can read the pre-baked
    /// thumbnails through the FP mount without an extra API call.
    ///
    /// Finder still hides the entry from human users because the name
    /// starts with `.`, so user-visible listings are unaffected.
    public init(mapleDir folderID: String,
                parentRelativePath: String,
                parentIdentifier: NSFileProviderItemIdentifier) {
        self.identifier = .mapleDir(folderID: folderID, parentRelativePath: parentRelativePath)
        self.displayName = ".maple"
        self.isDirectory = true
        self.size = nil
        self.modified = nil
        self.utType = .folder
        // Read-only. No uploads, no nested writes — the cache is
        // server-owned. `.allowsContentEnumerating` is required for
        // the OS to follow through to the `.maple/thumbs/` enumerator.
        self.writeCapabilities = [.allowsReading, .allowsContentEnumerating]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentIdentifier
        self.filename = ".maple"
    }

    /// Synthetic `.maple/thumbs/` directory — the only child of a
    /// `.mapleDir`. Children are one `.thumb(assetID:)` per indexed
    /// image in `parentRelativePath`, named with the server's
    /// `sha256_prefix16(basename).avif` convention.
    public init(mapleThumbsDir folderID: String,
                parentRelativePath: String,
                parentIdentifier: NSFileProviderItemIdentifier) {
        self.identifier = .mapleThumbsDir(folderID: folderID, parentRelativePath: parentRelativePath)
        self.displayName = "thumbs"
        self.isDirectory = true
        self.size = nil
        self.modified = nil
        self.utType = .folder
        self.writeCapabilities = [.allowsReading, .allowsContentEnumerating]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentIdentifier
        self.filename = "thumbs"
    }

    /// Pre-rendered thumbnail AVIF. `displayFilename` is the server's
    /// on-disk name (`<sha256_prefix16(basename)>.avif`), derived by the
    /// enumerator from the paired RAW's filename. Identifier carries
    /// only the assetID — the OS reaches `fetchContents` with the
    /// `.thumb(assetID:)` shape and the extension hits
    /// `GET /api/assets/<id>/thumb` for the bytes.
    ///
    /// `size` and `modified` are left nil: the server doesn't surface
    /// thumb dimensions on directory listings, and we don't pre-fetch
    /// per-thumb stats during enumeration (one HEAD per asset would
    /// blow the enumeration budget). The OS materializes on demand and
    /// fills in the real size once bytes are written.
    public init(thumbForAsset assetID: String,
                displayFilename: String,
                parentIdentifier: NSFileProviderItemIdentifier) {
        self.identifier = .thumb(assetID: assetID)
        self.displayName = displayFilename
        self.isDirectory = false
        self.size = nil
        self.modified = nil
        self.utType = UTType(filenameExtension: "avif") ?? ThumbnailEncoder.utType
        // Read-only — `.maple/thumbs/` is a derived cache. Deletes
        // here would leak through to the server-side cache and the
        // next enumeration would just regenerate the entry.
        self.writeCapabilities = [.allowsReading]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentIdentifier
        self.filename = displayFilename
    }

    public init(sidecar: SidecarChild, parentImageBase: String, parentIdentifier: NSFileProviderItemIdentifier) {
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
