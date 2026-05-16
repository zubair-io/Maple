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
                // Library roots followed by one synthetic Trash item per
                // library. Phase 3: Finder shows "<Library> Trash" alongside
                // its photos folder; the .maple/ directory itself stays hidden.
                var items: [NSFileProviderItem] = roots.map { MapleItem(libraryRoot: $0) }
                items.append(contentsOf: roots.map {
                    MapleItem(trashContainer: $0.id, displayName: "\($0.label) Trash")
                })
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
            } catch {
                log.error("root enumerate failed: \(error.localizedDescription, privacy: .public)")
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
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "enumerator")

    /// `pageSize` is sent as the `?limit=` query param on every request.
    /// Defaults to 500 on macOS and 200 on iOS; the host extension picks
    /// the value via the platform-specific subclass entry-point. Tests
    /// override it to small numbers to exercise the multi-page path.
    public init(catalog: RemoteCatalog,
                folderID: String,
                relativePath: String,
                absolutePath: String,
                containerIdentifier: NSFileProviderItemIdentifier,
                pageSize: Int? = nil) {
        self.catalog = catalog
        self.folderID = folderID
        self.relativePath = relativePath
        self.absolutePath = absolutePath
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

    public func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
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
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    public func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("0".utf8)))
    }
}
