// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/MapleEnumerator.swift
import FileProvider
import OSLog

public final class RootEnumerator: NSObject, NSFileProviderEnumerator {
    private let catalog: RemoteCatalog
    private let rootCache: LibraryRootCache?
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "enumerator")

    public init(catalog: RemoteCatalog, rootCache: LibraryRootCache? = nil) {
        self.catalog = catalog
        self.rootCache = rootCache
    }

    public func invalidate() {}

    public func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        log.notice("root enumerate start cache=\(self.rootCache != nil, privacy: .public)")
        Task {
            do {
                // Hit the cache when present so the OS asking for the root
                // listing repeatedly doesn't generate a /api/folders round
                // trip each time. enumerateChanges drops the cache when the
                // main app signals a refresh, so user-triggered refreshes
                // still see new server-side folders.
                let roots: [LibraryRoot]
                if let cache = rootCache {
                    roots = try await cache.roots()
                } else {
                    roots = try await catalog.listFolders()
                }
                log.notice("root enumerate got \(roots.count, privacy: .public) roots: \(roots.map { $0.label }.joined(separator: ","), privacy: .public)")
                // Library roots followed by one synthetic Trash item per
                // library. Phase 3: Finder shows "<Library> Trash" alongside
                // its photos folder; the .maple/ directory itself stays hidden.
                var items: [NSFileProviderItem] = roots.map { MapleItem(libraryRoot: $0) }
                items.append(contentsOf: roots.map {
                    MapleItem(trashContainer: $0.id, displayName: "\($0.label) Trash")
                })
                log.notice("root enumerate published \(items.count, privacy: .public) items (incl. trash)")
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
            } catch {
                log.error("root enumerate failed: \(String(describing: error), privacy: .public)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    // Phase 1: enumerator changes are coarse — current state, no per-item delta.
    //
    // We DO NOT invalidate the LibraryRootCache here. The drift handler
    // installed on the cache calls signalEnumerator(.rootContainer)
    // whenever a background revalidation returns a list that differs
    // from the served one — by the time the OS calls enumerateChanges
    // in response, the in-memory cache already holds the fresh data.
    // Invalidating it here would wipe that fresh prime and force the
    // next `enumerateItems` to re-await the server round trip we just
    // completed.
    //
    // Any genuine external "drop the cache" event (e.g. a change-feed
    // event affecting folder membership) routes through
    // `FileProviderExtension.handleChangeEvent`, which invalidates the
    // cache explicitly before signaling the enumerator.
    public func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        // Intentionally inert (#2547): this container lists library roots,
        // which the asset change feed does not describe. Freshness comes
        // from a full re-enumeration on signal (see the comment above,
        // which is the actual freshness path for this container), not
        // from a delta.
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    public func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("0".utf8)))
    }
}

public final class FolderEnumerator: NSObject, NSFileProviderEnumerator {
    private let catalog: RemoteCatalog
    private let folderID: String
    private let relativePath: String
    private let absolutePath: String
    private let containerIdentifier: NSFileProviderItemIdentifier
    private let pageSize: Int
    private let cursorStore: ChangeCursorStore?
    private let domainID: String
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "enumerator")

    /// Per-call cap on rows pulled from `/api/changes`. Mirrors
    /// `WorkingSetEnumerator.changesPageLimit` / `DeferredFolderEnumerator`.
    private static let changesPageLimit = 500

    /// `pageSize` is sent as the `?limit=` query param on every request.
    /// Defaults to 500 on macOS and 200 on iOS; the host extension picks
    /// the value via the platform-specific subclass entry-point. Tests
    /// override it to small numbers to exercise the multi-page path.
    ///
    /// `cursorStore`/`domainID` are optional so existing call sites and
    /// tests compile unchanged — without a cursor store this type has no
    /// cursor source and falls back to the prior inert behavior (the
    /// container the OS actually enumerates is `DeferredFolderEnumerator`,
    /// which always supplies one; this type is its item-listing worker).
    public init(catalog: RemoteCatalog,
                folderID: String,
                relativePath: String,
                absolutePath: String,
                containerIdentifier: NSFileProviderItemIdentifier,
                pageSize: Int? = nil,
                cursorStore: ChangeCursorStore? = nil,
                domainID: String = "") {
        self.catalog = catalog
        self.folderID = folderID
        self.relativePath = relativePath
        self.absolutePath = absolutePath
        self.containerIdentifier = containerIdentifier
        self.cursorStore = cursorStore
        self.domainID = domainID
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
                var cursor: String? = nil
                var firstPage = true
                repeat {
                    let contents = try await catalog.listDir(absolutePath: absolutePath,
                                                              cursor: cursor,
                                                              limit: pageSize)
                    var items: [NSFileProviderItem] = contents.dirs.map { d in
                        MapleItem(subdirectory: d,
                                  parentFolderID: folderID,
                                  parentRelativePath: relativePath,
                                  parentIdentifier: containerIdentifier)
                    }
                    // Failable init filters out unindexed images.
                    items.append(contentsOf: contents.images.compactMap {
                        MapleItem(image: $0, parentIdentifier: containerIdentifier)
                    })
                    // Build a lookup from asset ID to that asset's filename
                    // base (no extension) so each sidecar can resolve
                    // canonical-vs-conflict status.
                    var assetIDToBase: [String: String] = [:]
                    for img in contents.images {
                        guard let id = img.assetID else { continue }
                        let dot = img.name.lastIndex(of: ".")
                        let base = dot.map { String(img.name[..<$0]) } ?? img.name
                        assetIDToBase[id] = base
                    }
                    for sidecar in contents.sidecars {
                        let base = assetIDToBase[sidecar.assetID] ?? sidecar.name
                        items.append(MapleItem(sidecar: sidecar,
                                               parentImageBase: base,
                                               parentIdentifier: containerIdentifier))
                    }
                    // Non-image files (video, documents, extensionless, …):
                    // stored + synced but never indexed, so they're addressed
                    // by their library-relative path rather than an asset id.
                    for file in contents.files {
                        let childRel = relativePath.isEmpty ? file.name : "\(relativePath)/\(file.name)"
                        items.append(MapleItem(file: file,
                                               folderID: folderID,
                                               relativePath: childRel,
                                               parentIdentifier: containerIdentifier))
                    }
                    // Inject the synthesized `.maple/` container on the
                    // first page only. The server's `/api/fs/dir` hides
                    // dotdirs (see `src/api/.../routes/fs.ts`), so we
                    // can't enumerate `.maple/` through the catalog —
                    // synthesize it client-side so future readers of
                    // the FP mount (the app's Folder-View path, #101)
                    // can find the pre-baked thumbnails next to the
                    // photos.
                    //
                    // The server's `.maple/thumbs/` lives under EVERY
                    // folder (per-folder layout — see
                    // `src/api/.../fs/xmp.ts` `resolveThumbPath`), so
                    // we surface one `.maple/` per enumerable folder
                    // regardless of depth, not just at the library root.
                    //
                    // Empty case (no thumbs cached yet, or empty parent
                    // folder) is handled naturally — the nested
                    // `.maple/thumbs/` enumerator returns an empty list
                    // and never touches the server's filesystem. Finder
                    // hides the entry from human users via the leading
                    // `.` so this only changes the machine-readable
                    // view.
                    if firstPage {
                        items.append(MapleItem(
                            mapleDir: folderID,
                            parentRelativePath: relativePath,
                            parentIdentifier: containerIdentifier
                        ))
                        firstPage = false
                    }
                    observer.didEnumerate(items)
                    cursor = contents.nextCursor
                } while cursor != nil
                observer.finishEnumerating(upTo: nil)
            } catch {
                log.error("folder enumerate failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    public func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        guard let cursorStore else {
            // No cursor source: report a stable anchor. The container the
            // OS actually enumerates is `DeferredFolderEnumerator`, which
            // has the real feed; this type is its listing worker.
            completionHandler(FolderChangeMatching.anchor(0))
            return
        }
        completionHandler(FolderChangeMatching.anchor(cursorStore.load(domain: domainID)))
    }

    public func enumerateChanges(for observer: NSFileProviderChangeObserver,
                                 from anchor: NSFileProviderSyncAnchor) {
        guard cursorStore != nil else {
            // No cursor source injected: keep the prior inert behavior
            // rather than fabricate a delta from nothing.
            observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
            return
        }
        let since = FolderChangeMatching.parseAnchor(anchor)
        Task { [weak self] in
            guard let self else { return }
            do {
                let page = try await catalog.listChanges(since: since,
                                                         limit: Self.changesPageLimit)
                let split = FolderChangeMatching.partition(changes: page.changes,
                                                           folderID: folderID,
                                                           relativePath: relativePath)
                observer.didUpdate(split.updates)
                observer.didDeleteItems(withIdentifiers: split.deletes)
                let newAnchor = page.nextCursor.map { FolderChangeMatching.anchor($0) } ?? anchor
                // Only claim more is coming when the anchor actually moved.
                // A full page with no cursor would otherwise send the OS
                // back with the same anchor forever.
                let moreComing = page.nextCursor != nil && page.changes.count >= Self.changesPageLimit
                observer.finishEnumeratingChanges(upTo: newAnchor, moreComing: moreComing)
            } catch let e as StaleCursorError {
                log.notice("folder stale cursor (server current=\(e.current)); requesting full re-enumeration")
                observer.finishEnumeratingWithError(
                    NSError(domain: NSFileProviderErrorDomain,
                            code: NSFileProviderError.syncAnchorExpired.rawValue))
            } catch {
                log.error("folder enumerateChanges failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }
}

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
        let item = MapleItem(
            mapleThumbsDir: folderID,
            parentRelativePath: parentRelativePath,
            parentIdentifier: containerIdentifier
        )
        observer.didEnumerate([item])
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
    private let pageSize: Int
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "enumerator")

    public init(catalog: RemoteCatalog,
                folderID: String,
                parentAbsolutePath: String,
                containerIdentifier: NSFileProviderItemIdentifier,
                pageSize: Int? = nil) {
        self.catalog = catalog
        self.folderID = folderID
        self.parentAbsolutePath = parentAbsolutePath
        self.containerIdentifier = containerIdentifier
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
                var cursor: String? = nil
                repeat {
                    let contents = try await catalog.listDir(absolutePath: parentAbsolutePath,
                                                              cursor: cursor,
                                                              limit: pageSize)
                    var items: [NSFileProviderItem] = []
                    for img in contents.images {
                        // Skip unindexed images: a thumb item without
                        // an assetID has nothing to fetch. Mirrors the
                        // image-enumeration path (`MapleItem(image:)`
                        // is failable on the same condition).
                        guard let assetID = img.assetID, !assetID.isEmpty else { continue }
                        let thumbName = MapleThumbCacheKey.thumbFilename(forRawBasename: img.name)
                        items.append(MapleItem(
                            thumbForAsset: assetID,
                            displayFilename: thumbName,
                            parentIdentifier: containerIdentifier
                        ))
                    }
                    observer.didEnumerate(items)
                    cursor = contents.nextCursor
                } while cursor != nil
                observer.finishEnumerating(upTo: nil)
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

/// Per-library Trash enumerator. Paginates through `GET /api/folders/:id/trash`
/// and emits one `MapleItem(trashed:)` per row. The trashed items keep their
/// asset/<id> identifiers so the OS recognises them as the same item that
/// disappeared from a folder enumeration.
public final class TrashEnumerator: NSObject, NSFileProviderEnumerator {
    private let catalog: RemoteCatalog
    private let folderID: String
    private let containerIdentifier: NSFileProviderItemIdentifier
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "enumerator")

    public init(catalog: RemoteCatalog, folderID: String, containerIdentifier: NSFileProviderItemIdentifier) {
        self.catalog = catalog
        self.folderID = folderID
        self.containerIdentifier = containerIdentifier
    }

    public func invalidate() {}

    public func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            do {
                // Cursor encoded as the page bytes when present; nil for first page.
                let cursor: String? = {
                    guard let s = String(data: page.rawValue, encoding: .utf8), !s.isEmpty, s != "0" else { return nil }
                    return s
                }()
                let resp = try await catalog.listTrash(folderID: folderID, limit: 200, cursor: cursor)
                let items = resp.items.map { MapleItem(trashed: $0, parentTrashIdentifier: containerIdentifier) }
                observer.didEnumerate(items)
                if let nextCursor = resp.nextCursor {
                    observer.finishEnumerating(upTo: NSFileProviderPage(Data(nextCursor.utf8)))
                } else {
                    observer.finishEnumerating(upTo: nil)
                }
            } catch {
                log.error("trash enumerate failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    public func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        // Intentionally inert (#2547): trashed items come from
        // `GET /api/folders/:id/trash`, a separate feed the asset change
        // feed does not describe. Freshness comes from a full
        // re-enumeration on signal, not from a delta.
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    public func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("0".utf8)))
    }
}
