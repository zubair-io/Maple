// src/apple/MapleFileProvider/MapleEnumerator.swift
import FileProvider
import MapleCore
import OSLog

final class RootEnumerator: NSObject, NSFileProviderEnumerator {
    private let catalog: RemoteCatalog
    private let rootCache: LibraryRootCache?
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "enumerator")

    init(catalog: RemoteCatalog, rootCache: LibraryRootCache? = nil) {
        self.catalog = catalog
        self.rootCache = rootCache
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
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
                let items = roots.map { MapleItem(libraryRoot: $0) }
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
            } catch {
                log.error("root enumerate failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    // Phase 1: enumerator changes are coarse — current state, no per-item delta.
    // Invalidate the library-root cache so the next enumerateItems hits the server.
    // Triggered by NSFileProviderManager.signalEnumerator(for: .rootContainer) from the main app.
    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        Task {
            await rootCache?.invalidate()
            observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
        }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("0".utf8)))
    }
}

final class FolderEnumerator: NSObject, NSFileProviderEnumerator {
    private let catalog: RemoteCatalog
    private let folderID: String
    private let relativePath: String
    private let absolutePath: String
    private let containerIdentifier: NSFileProviderItemIdentifier
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "enumerator")

    init(catalog: RemoteCatalog,
         folderID: String,
         relativePath: String,
         absolutePath: String,
         containerIdentifier: NSFileProviderItemIdentifier) {
        self.catalog = catalog
        self.folderID = folderID
        self.relativePath = relativePath
        self.absolutePath = absolutePath
        self.containerIdentifier = containerIdentifier
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            do {
                let contents = try await catalog.listDir(absolutePath: absolutePath)
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
                // Build a lookup from asset ID to that asset's filename base
                // (no extension) so each sidecar can resolve canonical-vs-
                // conflict status.
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
                observer.finishEnumerating(upTo: nil)
            } catch {
                log.error("folder enumerate failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("0".utf8)))
    }
}
