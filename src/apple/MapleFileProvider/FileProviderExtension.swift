// src/apple/MapleFileProvider/FileProviderExtension.swift
import FileProvider
import MapleCore
import OSLog
import UniformTypeIdentifiers

final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
    private let domain: NSFileProviderDomain
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "extension")
    private let dormant: Bool
    private let catalog: RemoteCatalog?
    private let rootCache: LibraryRootCache?
    private let deviceName: String

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        let config = FileProviderConfig()
        let resolvedDeviceName = ProcessInfo.processInfo.hostName
        guard let cfg = config.load(domain: domain.identifier.rawValue) else {
            self.dormant = true
            self.catalog = nil
            self.rootCache = nil
            self.deviceName = resolvedDeviceName
            super.init()
            log.notice("init dormant — no config for domain \(domain.identifier.rawValue, privacy: .public)")
            return
        }
        let tokensStore = FileProviderTokensStore()
        let session = URLSession(configuration: .default)
        let domainID = domain.identifier.rawValue
        let http = AuthenticatedHTTPClient(
            server: cfg.serverURL,
            urlSession: session,
            tokensProvider: { tokensStore.load(domain: domainID) },
            onTokensRefreshed: { tokensStore.save($0, domain: domainID) },
            onSignOut: { tokensStore.remove(domain: domainID) }
        )
        let catalog = RemoteCatalog(http: http, server: cfg.serverURL)
        self.dormant = false
        self.catalog = catalog
        self.rootCache = LibraryRootCache(catalog: catalog)
        self.deviceName = resolvedDeviceName
        super.init()
        log.info("init domain=\(domain.identifier.rawValue, privacy: .public)")
    }

    private func notAuthenticatedError() -> NSError {
        NSError(domain: NSFileProviderErrorDomain,
                code: NSFileProviderError.notAuthenticated.rawValue)
    }

    func invalidate() { log.info("invalidate") }

    // MARK: - Item lookup

    func item(for identifier: NSFileProviderItemIdentifier,
              request: NSFileProviderRequest,
              completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        if dormant {
            completionHandler(nil, notAuthenticatedError())
            progress.completedUnitCount = 1
            return progress
        }
        guard let catalog = self.catalog, let rootCache = self.rootCache else {
            completionHandler(nil, notAuthenticatedError())
            progress.completedUnitCount = 1
            return progress
        }
        Task {
            defer { progress.completedUnitCount = 1 }
            if identifier == .rootContainer {
                completionHandler(RootContainerItem(), nil)
                return
            }
            do {
                let parsed = try FileProviderIdentifier(rawValue: identifier.rawValue)
                switch parsed {
                case .folder(let folderID, let relativePath):
                    if relativePath.isEmpty {
                        // Library root — look up by folderID via the cache.
                        let roots = try await rootCache.roots()
                        guard let root = roots.first(where: { $0.id == folderID }) else {
                            completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                                           code: NSFileProviderError.noSuchItem.rawValue))
                            return
                        }
                        completionHandler(MapleItem(libraryRoot: root), nil)
                    } else {
                        // We don't have a per-folder metadata endpoint. Phase 1: re-enumerate the
                        // parent and find the matching subdirectory. Cheap because folder listings
                        // are small. Listing failures (network/auth) propagate to the OS via the
                        // outer catch so Finder surfaces the real error.
                        let parentRelative = (relativePath as NSString).deletingLastPathComponent
                        let childName = (relativePath as NSString).lastPathComponent
                        let roots = try await rootCache.roots()
                        guard let root = roots.first(where: { $0.id == folderID }) else {
                            completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                                           code: NSFileProviderError.noSuchItem.rawValue))
                            return
                        }
                        let parentAbs = parentRelative.isEmpty ? root.path : "\(root.path)/\(parentRelative)"
                        let contents = try await catalog.listDir(absolutePath: parentAbs)
                        guard let dir = contents.dirs.first(where: { $0.name == childName }) else {
                            completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                                           code: NSFileProviderError.noSuchItem.rawValue))
                            return
                        }
                        let parentIdent = NSFileProviderItemIdentifier(
                            FileProviderIdentifier.folder(folderID: folderID, relativePath: parentRelative).rawValue
                        )
                        completionHandler(
                            MapleItem(subdirectory: dir,
                                      parentFolderID: folderID,
                                      parentRelativePath: parentRelative,
                                      parentIdentifier: parentIdent),
                            nil
                        )
                    }
                case .asset:
                    // Phase 1: lone asset lookup is not supported (would require a per-asset
                    // metadata endpoint we don't expose yet). The OS gets the item via the
                    // folder enumeration that surfaced it; if it asks again, re-enumerate.
                    completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                                   code: NSFileProviderError.noSuchItem.rawValue))
                case .sidecar:
                    // Sidecar item lookup not yet supported; the OS receives items via
                    // folder enumeration.
                    completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                                   code: NSFileProviderError.noSuchItem.rawValue))
                }
            } catch {
                log.error("item(for:) failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(nil, error)
            }
        }
        return progress
    }

    // MARK: - Content fetch

    func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier,
                       version requestedVersion: NSFileProviderItemVersion?,
                       request: NSFileProviderRequest,
                       completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        if dormant {
            completionHandler(nil, nil, notAuthenticatedError())
            progress.completedUnitCount = 1
            return progress
        }
        guard let catalog = self.catalog else {
            completionHandler(nil, nil, notAuthenticatedError())
            progress.completedUnitCount = 1
            return progress
        }
        Task {
            defer { progress.completedUnitCount = 1 }
            do {
                let parsed = try FileProviderIdentifier(rawValue: itemIdentifier.rawValue)
                guard case .asset(let id) = parsed else {
                    completionHandler(nil, nil, NSError(domain: NSFileProviderErrorDomain,
                                                        code: NSFileProviderError.noSuchItem.rawValue))
                    return
                }
                let manager = NSFileProviderManager(for: domain)
                let tmpDir = (try? manager?.temporaryDirectoryURL()) ?? FileManager.default.temporaryDirectory
                let localURL = tmpDir.appendingPathComponent(UUID().uuidString)
                try await catalog.downloadAsset(assetID: id, to: localURL)
                // Pass nil for the item: the OS will reuse metadata from the prior enumeration.
                // We don't know the asset's real parent here (only the assetID), so we must not
                // synthesize one.
                completionHandler(localURL, nil, nil)
            } catch {
                log.error("fetch failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(nil, nil, error)
            }
        }
        return progress
    }

    // MARK: - Enumeration

    func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier,
                    request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        if dormant {
            // Throw so Finder surfaces an auth-required state instead of
            // a misleading empty folder. The main app populating config
            // and signalling the extension transitions out of dormant.
            throw notAuthenticatedError()
        }
        guard let catalog = self.catalog, let rootCache = self.rootCache else {
            throw notAuthenticatedError()
        }
        if containerItemIdentifier == .rootContainer {
            return RootEnumerator(catalog: catalog, rootCache: rootCache)
        }
        if containerItemIdentifier == .workingSet || containerItemIdentifier == .trashContainer {
            return EmptyEnumerator()
        }
        let parsed = try FileProviderIdentifier(rawValue: containerItemIdentifier.rawValue)
        switch parsed {
        case .folder(let folderID, let relativePath):
            return DeferredFolderEnumerator(catalog: catalog,
                                            rootCache: rootCache,
                                            folderID: folderID,
                                            relativePath: relativePath,
                                            containerIdentifier: containerItemIdentifier)
        case .asset:
            throw NSError(domain: NSFileProviderErrorDomain,
                          code: NSFileProviderError.noSuchItem.rawValue)
        case .sidecar:
            // Sidecars are leaf items, not containers — cannot be enumerated.
            throw NSError(domain: NSFileProviderErrorDomain,
                          code: NSFileProviderError.noSuchItem.rawValue)
        }
    }

    // MARK: - XMP write paths

    func createItem(basedOn itemTemplate: NSFileProviderItem,
                    fields: NSFileProviderItemFields,
                    contents url: URL?,
                    options: NSFileProviderCreateItemOptions = [],
                    request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        if dormant {
            completionHandler(nil, [], false, notAuthenticatedError())
            return Progress()
        }
        guard let catalog = self.catalog else {
            completionHandler(nil, [], false, notAuthenticatedError())
            return Progress()
        }
        // Only XMP sidecars are writable in Phase 2.
        let filename = itemTemplate.filename
        guard filename.lowercased().hasSuffix(".xmp"),
              let contentsURL = url else {
            completionHandler(nil, [], false,
                NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
        let progress = Progress(totalUnitCount: 1)
        Task {
            defer { progress.completedUnitCount = 1 }
            do {
                let xmpBytes = try Data(contentsOf: contentsURL)
                let parentID = itemTemplate.parentItemIdentifier
                guard let assetID = try await self.assetID(forSidecarNamed: filename,
                                                            in: parentID,
                                                            catalog: catalog) else {
                    completionHandler(nil, [], false,
                        NSError(domain: NSFileProviderErrorDomain,
                                code: NSFileProviderError.noSuchItem.rawValue))
                    return
                }
                let result = try await catalog.putXMP(
                    assetID: assetID,
                    data: xmpBytes,
                    ifMtimeMatches: nil,
                    deviceName: self.deviceName
                )
                switch result {
                case .ok(let mtime):
                    // `path` is unknown here — server didn't return the absolute path on
                    // the 204 path. The field is informational; nothing in MapleItem reads
                    // it. Use the filename so it's at least self-describing.
                    let synthesized = SidecarChild(
                        name: filename,
                        path: filename,
                        mtime: mtime,
                        size: Int64(xmpBytes.count),
                        assetID: assetID
                    )
                    let baseFromFilename = Self.canonicalBase(forSidecarFilename: filename)
                    let item = MapleItem(sidecar: synthesized,
                                         parentImageBase: baseFromFilename,
                                         parentIdentifier: parentID)
                    completionHandler(item, [], false, nil)
                case .conflict(let conflictPath, let conflictMtime):
                    self.log.notice("createItem conflict — server wrote to \(conflictPath, privacy: .public)")
                    let conflictName = (conflictPath as NSString).lastPathComponent
                    let synthesized = SidecarChild(
                        name: conflictName,
                        path: conflictPath,
                        mtime: conflictMtime,
                        size: Int64(xmpBytes.count),
                        assetID: assetID
                    )
                    let baseFromFilename = Self.canonicalBase(forSidecarFilename: filename)
                    let collidingItem = MapleItem(sidecar: synthesized,
                                                  parentImageBase: baseFromFilename,
                                                  parentIdentifier: parentID)
                    completionHandler(nil, [], false,
                        NSError(domain: NSFileProviderErrorDomain,
                                code: NSFileProviderError.filenameCollision.rawValue,
                                userInfo: [NSFileProviderErrorItemKey: collidingItem]))
                    await self.signalEnumeratorReload(parent: parentID)
                }
            } catch {
                self.log.error("createItem failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(nil, [], false, error)
            }
        }
        return progress
    }

    func modifyItem(_ item: NSFileProviderItem,
                    baseVersion version: NSFileProviderItemVersion,
                    changedFields: NSFileProviderItemFields,
                    contents newContents: URL?,
                    options: NSFileProviderModifyItemOptions = [],
                    request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        if dormant {
            completionHandler(nil, [], false, notAuthenticatedError())
            return Progress()
        }
        guard let catalog = self.catalog else {
            completionHandler(nil, [], false, notAuthenticatedError())
            return Progress()
        }
        let parsed: FileProviderIdentifier
        do { parsed = try FileProviderIdentifier(rawValue: item.itemIdentifier.rawValue) }
        catch {
            completionHandler(nil, [], false,
                NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
        guard case .sidecar(let assetID, _) = parsed,
              let contentsURL = newContents else {
            completionHandler(nil, [], false,
                NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
        // Decode the prior mtime from the version's contentVersion field
        // (same encoding MapleItem.itemVersion uses: ASCII epoch seconds).
        let priorMtime: Date? = {
            guard let s = String(data: version.contentVersion, encoding: .utf8),
                  let epoch = Int(s), epoch > 0 else { return nil }
            return Date(timeIntervalSince1970: TimeInterval(epoch))
        }()
        let progress = Progress(totalUnitCount: 1)
        Task {
            defer { progress.completedUnitCount = 1 }
            do {
                let xmpBytes = try Data(contentsOf: contentsURL)
                let result = try await catalog.putXMP(
                    assetID: assetID,
                    data: xmpBytes,
                    ifMtimeMatches: priorMtime,
                    deviceName: self.deviceName
                )
                switch result {
                case .ok(let mtime):
                    // `path` is unknown here — server didn't return the absolute path on
                    // the 204 path. The field is informational; nothing in MapleItem reads
                    // it. Use the filename so it's at least self-describing.
                    let synthesized = SidecarChild(
                        name: item.filename,
                        path: item.filename,
                        mtime: mtime,
                        size: Int64(xmpBytes.count),
                        assetID: assetID
                    )
                    let baseFromFilename = Self.canonicalBase(forSidecarFilename: item.filename)
                    let updatedItem = MapleItem(sidecar: synthesized,
                                                parentImageBase: baseFromFilename,
                                                parentIdentifier: item.parentItemIdentifier)
                    completionHandler(updatedItem, [], false, nil)
                case .conflict(let conflictPath, let conflictMtime):
                    self.log.notice("modifyItem conflict — server wrote to \(conflictPath, privacy: .public)")
                    let conflictName = (conflictPath as NSString).lastPathComponent
                    let synthesized = SidecarChild(
                        name: conflictName,
                        path: conflictPath,
                        mtime: conflictMtime,
                        size: Int64(xmpBytes.count),
                        assetID: assetID
                    )
                    let baseFromFilename = Self.canonicalBase(forSidecarFilename: item.filename)
                    let collidingItem = MapleItem(sidecar: synthesized,
                                                  parentImageBase: baseFromFilename,
                                                  parentIdentifier: item.parentItemIdentifier)
                    completionHandler(nil, [], false,
                        NSError(domain: NSFileProviderErrorDomain,
                                code: NSFileProviderError.filenameCollision.rawValue,
                                userInfo: [NSFileProviderErrorItemKey: collidingItem]))
                    await self.signalEnumeratorReload(parent: item.parentItemIdentifier)
                }
            } catch {
                self.log.error("modifyItem failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(nil, [], false, error)
            }
        }
        return progress
    }

    func deleteItem(identifier: NSFileProviderItemIdentifier,
                    baseVersion version: NSFileProviderItemVersion,
                    options: NSFileProviderDeleteItemOptions = [],
                    request: NSFileProviderRequest,
                    completionHandler: @escaping (Error?) -> Void) -> Progress {
        if dormant {
            completionHandler(notAuthenticatedError())
            return Progress()
        }
        guard let catalog = self.catalog else {
            completionHandler(notAuthenticatedError())
            return Progress()
        }
        let parsed: FileProviderIdentifier
        do { parsed = try FileProviderIdentifier(rawValue: identifier.rawValue) }
        catch {
            completionHandler(NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
        guard case .sidecar(let assetID, _) = parsed else {
            completionHandler(NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
        let progress = Progress(totalUnitCount: 1)
        Task {
            defer { progress.completedUnitCount = 1 }
            do {
                try await catalog.deleteXMP(assetID: assetID)
                completionHandler(nil)
            } catch {
                self.log.error("deleteItem failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(error)
            }
        }
        return progress
    }

    // MARK: - Sidecar helpers

    /// Find the asset whose RAW filename (without extension) matches the
    /// sidecar's canonical base. Returns nil if no matching image is in
    /// the enumeration response for the parent folder.
    private func assetID(forSidecarNamed filename: String,
                         in parentID: NSFileProviderItemIdentifier,
                         catalog: RemoteCatalog) async throws -> String? {
        guard let rootCache = self.rootCache else { return nil }
        let parsed = try FileProviderIdentifier(rawValue: parentID.rawValue)
        guard case .folder(let folderID, let relativePath) = parsed else { return nil }
        let roots = try await rootCache.roots()
        guard let root = roots.first(where: { $0.id == folderID }) else { return nil }
        let absolutePath = relativePath.isEmpty ? root.path : "\(root.path)/\(relativePath)"
        let contents = try await catalog.listDir(absolutePath: absolutePath)
        let canonicalBase = Self.canonicalBase(forSidecarFilename: filename)
        for img in contents.images {
            guard let assetID = img.assetID else { continue }
            let dot = img.name.lastIndex(of: ".")
            let imgBase = dot.map { String(img.name[..<$0]) } ?? img.name
            if imgBase == canonicalBase { return assetID }
        }
        return nil
    }

    /// Strip the `.xmp` extension and an optional `" (conflict from …)"`
    /// suffix from a sidecar filename. Case-insensitive on the `.xmp`
    /// extension; mirrors the server-side regex
    /// `canonicalBaseFromSidecarFilename`.
    static func canonicalBase(forSidecarFilename name: String) -> String {
        var s = name
        if s.lowercased().hasSuffix(".xmp") { s = String(s.dropLast(4)) }
        if s.hasSuffix(")"),
           let openParen = s.range(of: " (conflict from ") {
            s = String(s[..<openParen.lowerBound])
        }
        return s
    }

    private func signalEnumeratorReload(parent: NSFileProviderItemIdentifier) async {
        guard let mgr = NSFileProviderManager(for: domain) else { return }
        try? await mgr.signalEnumerator(for: parent)
    }
}

// MARK: - Library-root cache

/// Caches `/api/folders` for the lifetime of the extension process.
/// Cleared via `invalidate()`; refreshed on first call after that.
actor LibraryRootCache {
    private let catalog: RemoteCatalog
    private var cached: [LibraryRoot]?

    init(catalog: RemoteCatalog) { self.catalog = catalog }

    func roots() async throws -> [LibraryRoot] {
        if let c = cached { return c }
        let r = try await catalog.listFolders()
        cached = r
        return r
    }

    func invalidate() { cached = nil }
}

// MARK: - Deferred folder enumerator

/// Resolves `folderID + relativePath` -> absolute path on first `enumerateItems`
/// using the cached library-roots list, then delegates to `FolderEnumerator`.
final class DeferredFolderEnumerator: NSObject, NSFileProviderEnumerator {
    private let catalog: RemoteCatalog
    private let rootCache: LibraryRootCache
    private let folderID: String
    private let relativePath: String
    private let containerIdentifier: NSFileProviderItemIdentifier
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "enumerator")

    init(catalog: RemoteCatalog,
         rootCache: LibraryRootCache,
         folderID: String,
         relativePath: String,
         containerIdentifier: NSFileProviderItemIdentifier) {
        self.catalog = catalog
        self.rootCache = rootCache
        self.folderID = folderID
        self.relativePath = relativePath
        self.containerIdentifier = containerIdentifier
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            do {
                let roots = try await rootCache.roots()
                guard let root = roots.first(where: { $0.id == folderID }) else {
                    observer.finishEnumeratingWithError(
                        NSError(domain: NSFileProviderErrorDomain,
                                code: NSFileProviderError.noSuchItem.rawValue))
                    return
                }
                let absolutePath = relativePath.isEmpty ? root.path : "\(root.path)/\(relativePath)"
                let inner = FolderEnumerator(catalog: catalog,
                                             folderID: folderID,
                                             relativePath: relativePath,
                                             absolutePath: absolutePath,
                                             containerIdentifier: containerIdentifier)
                inner.enumerateItems(for: observer, startingAt: page)
            } catch {
                log.error("deferred enumerate failed: \(error.localizedDescription, privacy: .public)")
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

// MARK: - Placeholder items

private final class RootContainerItem: NSObject, NSFileProviderItem {
    var itemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var parentItemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var filename: String { "Maple" }
    var contentType: UTType { .folder }
    var capabilities: NSFileProviderItemCapabilities { [.allowsContentEnumerating] }
}

final class EmptyEnumerator: NSObject, NSFileProviderEnumerator {
    func invalidate() {}
    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        observer.didEnumerate([])
        observer.finishEnumerating(upTo: nil)
    }
    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }
    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("0".utf8)))
    }
}
