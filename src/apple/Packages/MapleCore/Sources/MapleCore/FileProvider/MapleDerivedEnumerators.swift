// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/MapleDerivedEnumerators.swift
//
// The synthetic `.maple/` views the File Provider mount exposes: the
// directory itself, the kinds of derivative it can hold, and the
// `.maple/thumbs/` listing. Split out of `MapleEnumerator.swift` for the
// file-size budget (#2311) — these surface the server's derivative cache,
// a separate concern from the root / folder / trash enumerators that list
// the library's real contents. A straight move; no behaviour change.

import FileProvider
import OSLog

/// Synthetic `.maple/` enumerator. Always returns a single child:
/// the `thumbs/` subdirectory. The server's `.maple/` cache also
/// contains `previews/` (size-keyed JPEG previews) but those aren't
/// useful through the FP mount yet — exposing only `thumbs/` matches
/// what the future Folder-View reader (#101) expects.
public final class MapleDirEnumerator: NSObject, NSFileProviderEnumerator {
    private let folderID: String
    private let parentRelativePath: String
    private let containerIdentifier: NSFileProviderItemIdentifier

    public init(folderID: String,
                parentRelativePath: String,
                containerIdentifier: NSFileProviderItemIdentifier) {
        self.folderID = folderID
        self.parentRelativePath = parentRelativePath
        self.containerIdentifier = containerIdentifier
    }

    public func invalidate() {}

    public func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        // `thumbs/` and, since #3571, `previews/` — the two derived caches
        // the server keeps under every folder's `.maple/`.
        let items: [NSFileProviderItem] = [
            MapleItem(
                mapleThumbsDir: folderID,
                parentRelativePath: parentRelativePath,
                parentIdentifier: containerIdentifier
            ),
            MapleItem(
                maplePreviewsDir: folderID,
                parentRelativePath: parentRelativePath,
                parentIdentifier: containerIdentifier
            ),
        ]
        observer.didEnumerate(items)
        observer.finishEnumerating(upTo: nil)
    }

    public func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        // Intentionally inert (#2547): this container always synthesizes
        // the same single `thumbs/` child client-side — there is no server
        // state for it to drift from, so there is nothing a delta could
        // report.
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    public func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("0".utf8)))
    }
}

/// Which derived cache under `.maple/` an enumerator or item stands for.
public enum MapleDerivedKind: Sendable, Equatable {
    /// `.maple/thumbs/<sha256_prefix16(filename)>.avif`, 512 px grid thumb.
    case thumbs
    /// `.maple/previews/<filename>.avif`, the developed 1280 px preview (#3571).
    case previews

    /// The on-disk filename the server uses for `rawBasename`'s entry.
    public func filename(forRawBasename rawBasename: String) -> String {
        switch self {
        case .thumbs: return MapleThumbCacheKey.thumbFilename(forRawBasename: rawBasename)
        case .previews: return MapleItem.previewFilename(forRawBasename: rawBasename)
        }
    }

    /// The item for `assetID`'s entry, versioned by `modified` (see
    /// `MapleItem.init(thumbForAsset:)` on what that seed means).
    public func item(assetID: String, rawBasename: String, modified: Date?,
                     parentIdentifier: NSFileProviderItemIdentifier) -> MapleItem {
        switch self {
        case .thumbs:
            return MapleItem(thumbForAsset: assetID,
                             displayFilename: filename(forRawBasename: rawBasename),
                             modified: modified,
                             parentIdentifier: parentIdentifier)
        case .previews:
            return MapleItem(previewForAsset: assetID,
                             displayFilename: filename(forRawBasename: rawBasename),
                             modified: modified,
                             parentIdentifier: parentIdentifier)
        }
    }
}

/// Synthetic `.maple/thumbs/` enumerator. Pages through the PARENT
/// folder's image listing (same `catalog.listDir(...)` call the
/// `FolderEnumerator` uses) and surfaces one `.thumb(assetID:)` per
/// indexed image, named with the server's on-disk filename convention
/// (`<sha256_prefix16(image basename)>.avif`).
///
/// Empty parent → empty enumeration, NOT an error: a brand-new library
/// with no synced thumbs still has a valid (just-empty) `.maple/thumbs/`
/// view. The server's actual `.maple/thumbs/` directory may not exist
/// on disk either; that's fine because we never call `listDir` on it.
public final class MapleThumbsEnumerator: NSObject, NSFileProviderEnumerator {
    private let catalog: RemoteCatalog
    private let folderID: String
    private let parentAbsolutePath: String
    private let containerIdentifier: NSFileProviderItemIdentifier
    private let kind: MapleDerivedKind
    private let pageSize: Int
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "enumerator")

    public init(catalog: RemoteCatalog,
                folderID: String,
                parentAbsolutePath: String,
                containerIdentifier: NSFileProviderItemIdentifier,
                kind: MapleDerivedKind = .thumbs,
                pageSize: Int? = nil) {
        self.catalog = catalog
        self.folderID = folderID
        self.parentAbsolutePath = parentAbsolutePath
        self.containerIdentifier = containerIdentifier
        self.kind = kind
        #if os(iOS)
        self.pageSize = pageSize ?? 200
        #else
        self.pageSize = pageSize ?? 500
        #endif
    }

    public func invalidate() {}

    public func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            do {
                // #2550: one server page per call, resuming from the
                // OS's own page token — see `FileProviderPageCursor`'s
                // doc comment and `FolderEnumerator.enumerateItems`,
                // which this mirrors exactly.
                let cursor = FileProviderPageCursor.decode(page)
                let contents = try await catalog.listDir(absolutePath: parentAbsolutePath,
                                                          cursor: cursor,
                                                          limit: pageSize)
                // Version seed per asset (#3571): the sidecar's mtime when it
                // has one, else the RAW's — the same rule the change-feed
                // fan-out applies, so a re-enumeration and a change agree.
                let sidecarMtimeByAsset = Dictionary(
                    contents.sidecars.map { ($0.assetID, $0.mtime) },
                    uniquingKeysWith: { first, _ in first })
                var items: [NSFileProviderItem] = []
                for img in contents.images {
                    guard let assetID = img.assetID, !assetID.isEmpty else { continue }
                    items.append(kind.item(
                        assetID: assetID,
                        rawBasename: img.name,
                        modified: sidecarMtimeByAsset[assetID] ?? img.mtime,
                        parentIdentifier: containerIdentifier
                    ))
                }
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: contents.nextCursor.map(FileProviderPageCursor.encode))
            } catch {
                log.error("maple thumbs enumerate failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    public func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        // Intentionally inert (#2547): this container synthesizes
        // `.thumb(assetID:)` children from the parent folder's own image
        // listing rather than from the asset change feed, which the parent
        // folder's own `enumerateChanges` now drives. A delta here would
        // duplicate that signal, not add one.
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    public func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("0".utf8)))
    }
}
