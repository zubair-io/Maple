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
    /// Shared SQLite mirror used by the Quick Look extension to resolve a
    /// local cached file URL back to its asset ID. Best-effort: a store-
    /// open failure must not break the FP extension — Quick Look will
    /// degrade to OS-default RAW materialization in that case.
    private let metaStore: FileProviderMetaStore?
    /// Bounded working-set table. Reused across every WorkingSetEnumerator
    /// the OS instantiates within a single extension lifetime.
    private let workingSet: WorkingSet
    private let cursorStore: ChangeCursorStore
    private let workingSetListCache: WorkingSetListCache?
    /// Long-lived SSE consumer. Started in init when not dormant; stopped
    /// on `invalidate()`. nil while dormant.
    private var changeFeed: ChangeFeedClient?

    /// Upload allowlist for Phase 3 drag-in uploads. Mirrors the server's
    /// RAW_EXTENSIONS ∪ SHARP_EXTENSIONS — any file outside this set
    /// rejects with NSFileWriteUnknownError so Finder surfaces a normal
    /// "operation can't be completed" dialog instead of a server 415.
    private static let uploadableExtensions: Set<String> = [
        "cr2", "cr3", "nef", "arw", "dng", "raf", "orf", "rw2", "pef", "srw",
        "jpg", "jpeg", "png", "webp", "gif", "tif", "tiff", "heic", "heif", "avif",
    ]

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        let config = FileProviderConfig()
        let resolvedDeviceName = ProcessInfo.processInfo.hostName
        let resolvedMetaStore: FileProviderMetaStore? = {
            do { return try FileProviderMetaStore() } catch {
                Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "extension")
                    .error("FileProviderMetaStore open failed: \(String(describing: error), privacy: .public)")
                return nil
            }
        }()
        guard let cfg = config.load(domain: domain.identifier.rawValue) else {
            self.dormant = true
            self.catalog = nil
            self.rootCache = nil
            self.deviceName = resolvedDeviceName
            self.metaStore = resolvedMetaStore
            self.workingSet = WorkingSet(capacity: 20_000)
            self.cursorStore = ChangeCursorStore()
            self.workingSetListCache = nil
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
        let resolvedWorkingSet = WorkingSet(capacity: 20_000)
        let resolvedCursorStore = ChangeCursorStore()
        self.dormant = false
        self.catalog = catalog
        // LibraryRootCache primes from App Group `UserDefaults` so the
        // first `roots()` call after a cold extension launch returns
        // synchronously. The drift handler is wired up at construction
        // time so a revalidation that lands BEFORE we get to the
        // post-`super.init()` block still publishes the signal — the
        // earlier "set later" shape left a race window where the first
        // disk-primed read kicked a revalidation whose result was
        // observed before any handler was installed.
        let domainForDrift = domain
        let driftHandler: LibraryRootCache.DriftHandler = { @Sendable in
            guard let mgr = NSFileProviderManager(for: domainForDrift) else { return }
            try? await mgr.signalEnumerator(for: .rootContainer)
        }
        let rootCache = LibraryRootCache(
            domainID: domainID,
            driftHandler: driftHandler,
            fetcher: { [catalog] in try await catalog.listFolders() }
        )
        self.rootCache = rootCache
        self.deviceName = resolvedDeviceName
        self.metaStore = resolvedMetaStore
        self.workingSet = resolvedWorkingSet
        self.cursorStore = resolvedCursorStore
        self.workingSetListCache = WorkingSetListCache(catalog: catalog)
        super.init()
        // Wire up the SSE client after super.init so we can capture self.
        // Tokens are read on every reconnect — they're refreshed by the
        // host app and we don't want to hold a stale snapshot.
        self.changeFeed = ChangeFeedClient(
            server: cfg.serverURL,
            tokensProvider: { tokensStore.load(domain: domainID) },
            cursorStore: resolvedCursorStore,
            domainID: domainID,
            catalog: catalog,
            onEvent: { [weak self] event in
                guard let self else { return }
                await self.handleChangeEvent(event)
            },
            onStaleCursor: { [weak self] _ in
                // Server returned 409 — our cursor is stranded. Force
                // the OS to re-enumerate the working set so it pulls
                // everything afresh from the new server cursor (which
                // the client already saved before invoking us).
                guard let self else { return }
                guard let mgr = NSFileProviderManager(for: self.domain) else { return }
                try? await mgr.signalEnumerator(for: .workingSet)
            }
        )
        self.changeFeed?.start()
        log.info("init domain=\(domain.identifier.rawValue, privacy: .public)")
    }

    private func notAuthenticatedError() -> NSError {
        NSError(domain: NSFileProviderErrorDomain,
                code: NSFileProviderError.notAuthenticated.rawValue)
    }

    func invalidate() {
        changeFeed?.stop()
        log.info("invalidate")
    }

    // MARK: - Change-feed handling

    /// Called by ChangeFeedClient on every SSE-delivered event. Updates
    /// the working-set bookkeeping and signals the working-set
    /// enumerator and the affected folder (root or nested) so the OS
    /// pulls the new state.
    private func handleChangeEvent(_ event: AssetChange) async {
        if let assetID = event.assetID {
            let ident = FileProviderIdentifier.asset(assetID).rawValue
            switch event.kind {
            case .delete:
                workingSet.remove(identifier: ident)
            default:
                workingSet.upsert(identifier: ident, kind: .recent,
                                  lastTouched: event.at)
            }
        }
        guard let mgr = NSFileProviderManager(for: domain) else { return }
        try? await mgr.signalEnumerator(for: .workingSet)
        if let folderID = event.folderID {
            // Resolve the affected sub-folder if the event carries an
            // `absPath`. Previously we always signalled the root, which
            // meant a Finder window deep inside the library never saw
            // an update until the user re-navigated. With `absPath` and
            // the cached library roots we can strip the matching root
            // prefix and signal `folder(folderID, relativeDir)` so the
            // exact directory the file lives in repaints. When no root
            // matches the absPath we skip the per-folder signal — the
            // `.workingSet` signal above is still in flight and will
            // pick up the change.
            if let folderIdent = await deriveFolderIdentifier(
                folderID: folderID,
                absPath: event.absPath
            ) {
                try? await mgr.signalEnumerator(for: folderIdent)
            }
            // Folder counts may have shifted — drop the library-root cache
            // so the next root enumeration re-reads.
            await rootCache?.invalidate()
        }
    }

    /// Derive the FP folder identifier for an event payload. Returns nil
    /// when the absPath doesn't fall under any cached library root, so
    /// the caller can skip a per-folder signal that would target an
    /// identifier the OS doesn't understand. The root-level signal at
    /// the call site keeps top-level views fresh in that case.
    private func deriveFolderIdentifier(folderID: String, absPath: String?) async
        -> NSFileProviderItemIdentifier?
    {
        guard let absPath, let cache = rootCache else { return nil }
        let roots: [LibraryRoot]
        do { roots = try await cache.roots() } catch { return nil }
        guard let root = roots.first(where: { $0.id == folderID }) else { return nil }
        // Normalise root.path to end without a trailing slash so
        // hasPrefix matches "/a/b/c.dng" against root "/a/b".
        let rootPath = root.path.hasSuffix("/")
            ? String(root.path.dropLast())
            : root.path
        guard absPath.hasPrefix(rootPath + "/") || absPath == rootPath else { return nil }
        let rel = String(absPath.dropFirst(rootPath.count + 1))
        let dir = (rel as NSString).deletingLastPathComponent
        let raw = FileProviderIdentifier.folder(folderID: folderID, relativePath: dir).rawValue
        return NSFileProviderItemIdentifier(raw)
    }

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
                case .asset(let assetID):
                    // Resolve via GET /api/assets/:id. Used by the OS
                    // after `WorkingSetEnumerator` hands back a stub
                    // item — without this round-trip the OS would see
                    // a placeholder filename and never get the real
                    // bytes. Returns nil on 404; we map to noSuchItem.
                    do {
                        guard let meta = try await catalog.getAsset(assetID: assetID) else {
                            completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                                           code: NSFileProviderError.noSuchItem.rawValue))
                            return
                        }
                        completionHandler(MapleItem(assetMetadata: meta), nil)
                    } catch {
                        log.error("getAsset failed: \(error.localizedDescription, privacy: .public)")
                        completionHandler(nil, error)
                    }
                case .sidecar:
                    // Sidecar item lookup not yet supported; the OS receives items via
                    // folder enumeration.
                    completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                                   code: NSFileProviderError.noSuchItem.rawValue))
                case .trash(let folderID):
                    let roots = try await rootCache.roots()
                    guard let root = roots.first(where: { $0.id == folderID }) else {
                        completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                                       code: NSFileProviderError.noSuchItem.rawValue))
                        return
                    }
                    completionHandler(MapleItem(trashContainer: folderID, displayName: "\(root.label) Trash"), nil)
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
                let manager = NSFileProviderManager(for: domain)
                let tmpDir = (try? manager?.temporaryDirectoryURL()) ?? FileManager.default.temporaryDirectory
                switch parsed {
                case .asset(let id):
                    // RAW: materialize under a random extensionless basename.
                    // The identifier carries no extension, so we can't append
                    // one here without a catalog round-trip — Quick Look
                    // discriminates RAW vs. sidecar by the *absence* of the
                    // `.xmp` suffix below, so an extensionless basename for
                    // RAWs is the contract.
                    let localURL = tmpDir.appendingPathComponent(UUID().uuidString)
                    try await catalog.downloadAsset(assetID: id, to: localURL)
                    self.recordMeta(domain: self.domain.identifier.rawValue,
                                    localBasename: localURL.lastPathComponent,
                                    assetID: id,
                                    conflictBasename: nil)
                    completionHandler(localURL, nil, nil)
                    return
                case .sidecar(let assetID, let conflictBasename):
                    // Sidecar: preserve the `.xmp` extension on the
                    // materialized URL so the Quick Look extension can tell
                    // sidecars apart from RAWs by basename alone (the meta
                    // store keys on `local_basename`, and a canonical
                    // sidecar's `conflict_basename` is NULL — without the
                    // extension preserved, MaplePreviewProvider's `.xmp`
                    // guard could not distinguish the two and would serve
                    // the asset JPEG for an XMP Quick Look request.
                    let localURL = tmpDir.appendingPathComponent(UUID().uuidString + ".xmp")
                    let bytes = try await catalog.getXMP(assetID: assetID, conflictBasename: conflictBasename)
                    try bytes.write(to: localURL, options: .atomic)
                    self.recordMeta(domain: self.domain.identifier.rawValue,
                                    localBasename: localURL.lastPathComponent,
                                    assetID: assetID,
                                    conflictBasename: conflictBasename)
                    completionHandler(localURL, nil, nil)
                    return
                case .folder, .trash:
                    completionHandler(nil, nil, NSError(domain: NSFileProviderErrorDomain,
                                                        code: NSFileProviderError.noSuchItem.rawValue))
                    return
                }
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
        if containerItemIdentifier == .workingSet {
            guard let listCache = workingSetListCache else {
                return EmptyEnumerator()
            }
            return WorkingSetEnumerator(catalog: catalog,
                                        workingSet: workingSet,
                                        cursorStore: cursorStore,
                                        domainID: domain.identifier.rawValue,
                                        listCache: listCache)
        }
        if containerItemIdentifier == .trashContainer {
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
        case .trash(let folderID):
            return TrashEnumerator(catalog: catalog,
                                   folderID: folderID,
                                   containerIdentifier: containerItemIdentifier)
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
        let filename = itemTemplate.filename
        let dot = filename.lastIndex(of: ".")
        let ext = dot.map { String(filename[filename.index(after: $0)...]).lowercased() } ?? ""

        // Phase 2 path: XMP sidecar create.
        if ext == "xmp" {
            return createXMPItem(basedOn: itemTemplate, contents: url, catalog: catalog, completionHandler: completionHandler)
        }

        // Phase 3 path: drag-in upload.
        if Self.uploadableExtensions.contains(ext) {
            return uploadItem(basedOn: itemTemplate, contents: url, catalog: catalog, completionHandler: completionHandler)
        }

        completionHandler(nil, [], false,
            NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
        return Progress()
    }

    /// XMP sidecar create — preserved from Phase 2.
    private func createXMPItem(basedOn itemTemplate: NSFileProviderItem,
                               contents url: URL?,
                               catalog: RemoteCatalog,
                               completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        guard let contentsURL = url else {
            completionHandler(nil, [], false,
                NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
        let progress = Progress(totalUnitCount: 1)
        let filename = itemTemplate.filename
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
                    let synthesized = SidecarChild(
                        name: filename, path: filename, mtime: mtime,
                        size: Int64(xmpBytes.count), assetID: assetID
                    )
                    let baseFromFilename = Self.canonicalBase(forSidecarFilename: filename)
                    let item = MapleItem(sidecar: synthesized,
                                         parentImageBase: baseFromFilename,
                                         parentIdentifier: parentID)
                    completionHandler(item, [], false, nil)
                case .conflict(let conflictPath, let conflictMtime):
                    self.log.notice("createItem XMP conflict — \(conflictPath, privacy: .public)")
                    let conflictName = (conflictPath as NSString).lastPathComponent
                    let synthesized = SidecarChild(
                        name: conflictName, path: conflictPath, mtime: conflictMtime,
                        size: Int64(xmpBytes.count), assetID: assetID
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
                self.log.error("createItem XMP failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(nil, [], false, error)
            }
        }
        return progress
    }

    /// Drag-in upload — Phase 3. Parent must be a normal folder under a
    /// library root; trash containers reject uploads with featureUnsupported.
    private func uploadItem(basedOn itemTemplate: NSFileProviderItem,
                            contents url: URL?,
                            catalog: RemoteCatalog,
                            completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        guard let contentsURL = url else {
            completionHandler(nil, [], false,
                NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError))
            return Progress()
        }
        let parentID = itemTemplate.parentItemIdentifier
        let parsed: FileProviderIdentifier
        do { parsed = try FileProviderIdentifier(rawValue: parentID.rawValue) }
        catch {
            completionHandler(nil, [], false,
                NSError(domain: NSFileProviderErrorDomain,
                        code: NSFileProviderError.noSuchItem.rawValue))
            return Progress()
        }
        // Reject uploads into the root container or into a trash container.
        guard case .folder(let folderID, let parentRelative) = parsed else {
            completionHandler(nil, [], false,
                NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
        let filename = itemTemplate.filename
        let targetRel = parentRelative.isEmpty ? filename : "\(parentRelative)/\(filename)"
        let progress = Progress(totalUnitCount: 1)
        Task {
            defer { progress.completedUnitCount = 1 }
            do {
                let outcome = try await catalog.uploadFile(
                    folderID: folderID,
                    targetRelativePath: targetRel,
                    fileURL: contentsURL,
                    mtime: itemTemplate.contentModificationDate ?? nil,
                )
                switch outcome {
                case .ok(let resp):
                    let attrs = try? FileManager.default.attributesOfItem(atPath: contentsURL.path)
                    let size = Int64((attrs?[.size] as? NSNumber)?.intValue ?? Int(resp.size))
                    let modified = Date(timeIntervalSince1970: TimeInterval(resp.mtime) / 1000)
                    let ext = (filename as NSString).pathExtension.lowercased()
                    let image = ImageChild(
                        name: filename,
                        path: resp.absPath,
                        mtime: modified,
                        size: size,
                        ext: ext,
                        assetID: resp.assetID
                    )
                    if let item = MapleItem(image: image, parentIdentifier: parentID) {
                        completionHandler(item, [], false, nil)
                    } else {
                        completionHandler(nil, [], false,
                            NSError(domain: NSFileProviderErrorDomain,
                                    code: NSFileProviderError.noSuchItem.rawValue))
                    }
                    await self.signalEnumeratorReload(parent: parentID)
                case .conflict:
                    completionHandler(nil, [], false,
                        NSError(domain: NSFileProviderErrorDomain,
                                code: NSFileProviderError.filenameCollision.rawValue))
                case .unsupported:
                    completionHandler(nil, [], false,
                        NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError))
                }
            } catch {
                self.log.error("upload failed: \(error.localizedDescription, privacy: .public)")
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

        // Restore: the only `modifyItem` shape Phase 3 understands for assets
        // is reparent FROM a trash container TO a folder, with no other
        // changes. Anything else (rename, in-place modify) is rejected.
        if case .asset(let assetID) = parsed,
           changedFields.contains(.parentItemIdentifier) {
            let newParentID = item.parentItemIdentifier
            let newParentParsed: FileProviderIdentifier
            do { newParentParsed = try FileProviderIdentifier(rawValue: newParentID.rawValue) }
            catch {
                completionHandler(nil, [], false,
                    NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
                return Progress()
            }
            // Phase 3 only restores into a normal folder under the SAME library.
            // Cross-library moves and renames-during-restore are deferred.
            guard case .folder(_, let newRelative) = newParentParsed else {
                completionHandler(nil, [], false,
                    NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
                return Progress()
            }
            let progress = Progress(totalUnitCount: 1)
            Task {
                defer { progress.completedUnitCount = 1 }
                do {
                    let filename = item.filename
                    let targetRel = newRelative.isEmpty ? filename : "\(newRelative)/\(filename)"
                    let resp = try await catalog.restoreAsset(assetID: assetID, targetRelativePath: targetRel)
                    let attrs = try? FileManager.default.attributesOfItem(atPath: resp.absPath)
                    let size = Int64((attrs?[.size] as? NSNumber)?.intValue ?? 0)
                    let modified = (attrs?[.modificationDate] as? Date) ?? Date()
                    let restoredName = (resp.absPath as NSString).lastPathComponent
                    let ext = (restoredName as NSString).pathExtension.lowercased()
                    let image = ImageChild(
                        name: restoredName,
                        path: resp.absPath,
                        mtime: modified,
                        size: size,
                        ext: ext,
                        assetID: resp.assetID
                    )
                    if let restored = MapleItem(image: image, parentIdentifier: newParentID) {
                        completionHandler(restored, [], false, nil)
                    } else {
                        completionHandler(nil, [], false,
                            NSError(domain: NSFileProviderErrorDomain,
                                    code: NSFileProviderError.noSuchItem.rawValue))
                    }
                    await self.signalEnumeratorReload(parent: newParentID)
                } catch {
                    self.log.error("restore failed: \(error.localizedDescription, privacy: .public)")
                    completionHandler(nil, [], false, error)
                }
            }
            return progress
        }

        guard case .sidecar(let assetID, let conflictBasename) = parsed,
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
                // Conflict copies are addressed by ?conflict=<basename> and
                // skip the mtime precondition: the user is editing this
                // exact file directly, not racing against the canonical.
                let result = try await catalog.putXMP(
                    assetID: assetID,
                    data: xmpBytes,
                    ifMtimeMatches: conflictBasename == nil ? priorMtime : nil,
                    deviceName: self.deviceName,
                    conflictBasename: conflictBasename
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
        let progress = Progress(totalUnitCount: 1)
        Task {
            defer { progress.completedUnitCount = 1 }
            do {
                switch parsed {
                case .sidecar(let assetID, let conflictBasename):
                    try await catalog.deleteXMP(assetID: assetID, conflictBasename: conflictBasename)
                    completionHandler(nil)
                case .asset(let assetID):
                    // Server distinguishes trash-vs-purge based on the current
                    // doc state; we just call DELETE. Idempotent.
                    try await catalog.deleteAsset(assetID: assetID)
                    completionHandler(nil)
                case .folder, .trash:
                    completionHandler(NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
                }
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

    /// Best-effort: a write failure here only means Quick Look will fall
    /// back to RAW materialization. We log and swallow.
    private func recordMeta(domain: String,
                            localBasename: String,
                            assetID: String,
                            conflictBasename: String?) {
        guard let metaStore else { return }
        do {
            try metaStore.put(domain: domain,
                              localBasename: localBasename,
                              assetID: assetID,
                              conflictBasename: conflictBasename)
        } catch {
            log.error("metaStore.put failed: \(error.localizedDescription, privacy: .public)")
        }
    }
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
