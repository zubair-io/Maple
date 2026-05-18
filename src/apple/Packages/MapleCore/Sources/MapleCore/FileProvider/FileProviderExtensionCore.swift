// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderExtensionCore.swift
import FileProvider
import OSLog
import UniformTypeIdentifiers

open class FileProviderExtensionCore: NSObject, NSFileProviderReplicatedExtension {
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

    /// Page size used when streaming a parent listing to resolve a single
    /// child by name (subdir lookup in `item(for:)`, sidecar→assetID lookup
    /// in `assetID(forSidecarNamed:in:catalog:)`). Matches the server's
    /// default page size so most directories resolve in one round-trip.
    static let itemLookupPageLimit: Int = 500
    /// Hard cap on pages walked before giving up — defence against a
    /// misbehaving server returning a non-terminating cursor chain.
    /// 100 pages × 500 entries = 50,000 children; well past any real
    /// directory the photo workflow produces.
    static let itemLookupMaxPages: Int = 100

    public required init(domain: NSFileProviderDomain) {
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
        let cfgOrFallback: FileProviderDomainConfig? = config.load(domain: domain.identifier.rawValue)
            ?? Self.devFallbackConfig(for: domain)
        guard let cfg = cfgOrFallback else {
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
        if config.load(domain: domain.identifier.rawValue) == nil {
            log.notice("DEV FALLBACK — using hardcoded serverURL=\(cfg.serverURL.absoluteString, privacy: .public) for domain \(domain.identifier.rawValue, privacy: .public). File-based config is unreadable from sandboxed extension when host is unsandboxed; remove this fallback once App Groups capability is on the provisioning profile.")
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
        let hasTokens = tokensStore.load(domain: domainID) != nil
        log.notice("init domain=\(domain.identifier.rawValue, privacy: .public) serverURL=\(cfg.serverURL.absoluteString, privacy: .public) hasTokens=\(hasTokens, privacy: .public) device=\(resolvedDeviceName, privacy: .public)")
        if !hasTokens {
            log.error("EXTENSION HAS NO AUTH TOKENS — host app must be signed in for this server. Open Maple, sign in, then the extension will pick them up on next launch.")
        }
    }

    private func notAuthenticatedError() -> NSError {
        NSError(domain: NSFileProviderErrorDomain,
                code: NSFileProviderError.notAuthenticated.rawValue)
    }

    /// Development-time fallback: when the on-disk config can't be read
    /// (the file-based FileProviderConfig doesn't survive an unsandboxed
    /// host → sandboxed extension hand-off because macOS's container
    /// manager doesn't bless files written from outside the sandbox),
    /// reconstruct the config from the domain identifier itself. The
    /// host-app sets the identifier to the server hostname via
    /// `FileProviderDomainController.domainIdentifier(for:)`, so we can
    /// reverse-derive a working serverURL.
    ///
    /// Scheme: `http://` for localhost (dev server on `bun run dev`
    /// rarely speaks TLS), `https://` for everything else.
    ///
    /// LIMITATION: the `host-port` parse is naive — `lastIndex(of: "-")`
    /// can't distinguish `my-server-8080` (host `my-server`, port 8080)
    /// from `my-server-8080` meaning the literal hostname. We guard
    /// against obvious garbage (numeric port, port < 65536) but the
    /// ambiguity is real. In practice the codebase controls both sides
    /// (`domainIdentifier(for:)` is the inverse) so the pairing round-
    /// trips correctly for everything it produces.
    ///
    /// REMOVE this fallback once the host app's provisioning profile
    /// carries the App Groups capability — then file-based config works
    /// in both directions and this path is dead code.
    static func devFallbackConfig(for domain: NSFileProviderDomain) -> FileProviderDomainConfig? {
        let id = domain.identifier.rawValue
        // domainIdentifier shape: "<host>" or "<host>-<port>" (see
        // FileProviderDomainController.domainIdentifier(for:)).
        var host = id
        var port: Int?
        if let dash = id.lastIndex(of: "-") {
            let portSlice = id[id.index(after: dash)...]
            // Numeric AND in-range AND non-empty. CharacterSet check
            // rejects "12a3" which Int() would also reject, but being
            // explicit makes the guard obvious.
            if !portSlice.isEmpty,
               portSlice.allSatisfy({ $0.isASCII && $0.isNumber }),
               let p = Int(portSlice), p > 0, p < 65536 {
                host = String(id[..<dash])
                port = p
            }
        }
        // Localhost in dev rarely runs TLS; using https would force a
        // cert handshake against `localhost` that the dev server
        // doesn't have. Anything else assumes https.
        let isLocalhost = host == "localhost" || host == "127.0.0.1" || host == "::1"
        var comps = URLComponents()
        comps.scheme = isLocalhost ? "http" : "https"
        comps.host = host
        if let port { comps.port = port }
        guard let url = comps.url else { return nil }
        return FileProviderDomainConfig(domainIdentifier: id,
                                        displayName: domain.displayName,
                                        serverURL: url)
    }

    open func invalidate() {
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
            // Resolve the affected sub-folder. Phase 6 item 2: the
            // change-feed payload now carries `relativePath` directly,
            // so we can build the folder identifier without consulting
            // the library-roots cache (no async round-trip). Fall back
            // to absPath-derivation when the payload pre-dates that
            // change (`relativePath == nil`), and to the root-level
            // `.workingSet` signal above when neither resolves. Always
            // valid; a Finder window deep inside the library still
            // repaints because the OS reattaches on enumeration.
            let folderIdent: NSFileProviderItemIdentifier? = {
                if let rel = event.relativePath {
                    let parentRel = (rel as NSString).deletingLastPathComponent
                    let raw = FileProviderIdentifier
                        .folder(folderID: folderID, relativePath: parentRel)
                        .rawValue
                    return NSFileProviderItemIdentifier(raw)
                }
                return nil
            }()
            if let folderIdent {
                try? await mgr.signalEnumerator(for: folderIdent)
            } else if let derived = await deriveFolderIdentifier(
                folderID: folderID,
                absPath: event.absPath
            ) {
                try? await mgr.signalEnumerator(for: derived)
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

    open func item(for identifier: NSFileProviderItemIdentifier,
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
            if identifier == .workingSet {
                // The working set is an OS-internal index, not a user-
                // visible folder. Returning a synthetic container with
                // `.folder` UTType made Finder display "Working Set" at
                // the library root. Returning noSuchItem here, combined
                // with `resolveAssetParent` giving every asset a real
                // folder parent (so no item is actually routed under
                // .workingSet), causes the OS to omit the container
                // from Finder entirely.
                completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                               code: NSFileProviderError.noSuchItem.rawValue))
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
                        // Stream pages and early-return on the first match so
                        // a folder with thousands of children doesn't get
                        // fully buffered into memory just to resolve one
                        // subdirectory's MapleItem.
                        let found = try await Self.findChildDir(
                            catalog: catalog,
                            absolutePath: parentAbs,
                            childName: childName,
                            log: log
                        )
                        guard let dir = found else {
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
                        let parent = await Self.resolveAssetParent(meta: meta, rootCache: rootCache)
                        completionHandler(MapleItem(assetMetadata: meta, parent: parent), nil)
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
                log.error("item(for:) failed id=\(identifier.rawValue, privacy: .public) err=\(String(describing: error), privacy: .public)")
                completionHandler(nil, error)
            }
        }
        return progress
    }

    // MARK: - Content fetch

    open func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier,
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
                log.notice("fetchContents id=\(itemIdentifier.rawValue, privacy: .public) tmpDir=\(tmpDir.path, privacy: .public)")
                switch parsed {
                case .asset(let id):
                    // RAW: materialize under a random extensionless basename.
                    // The identifier carries no extension, so we can't append
                    // one here without a catalog round-trip — Quick Look
                    // discriminates RAW vs. sidecar by the *absence* of the
                    // `.xmp` suffix below, so an extensionless basename for
                    // RAWs is the contract.
                    let localURL = tmpDir.appendingPathComponent(UUID().uuidString)
                    // Fetch metadata in parallel with the bytes — we need
                    // both to satisfy the macOS Sequoia/Tahoe contract:
                    // the completion handler MUST receive a non-nil
                    // NSFileProviderItem alongside the URL, or
                    // FPXExtensionContext aborts the extension with an
                    // NSAssertionHandler failure.
                    async let metaTask = catalog.getAsset(assetID: id)
                    async let downloadTask: Void = catalog.downloadAsset(assetID: id, to: localURL)
                    _ = try await downloadTask
                    let resolved = try await metaTask
                    guard let resolved else {
                        log.error("fetchContents asset \(id, privacy: .public) — getAsset returned nil")
                        completionHandler(nil, nil, NSError(domain: NSFileProviderErrorDomain,
                                                            code: NSFileProviderError.noSuchItem.rawValue))
                        return
                    }
                    self.recordMeta(domain: self.domain.identifier.rawValue,
                                    localBasename: localURL.lastPathComponent,
                                    assetID: id,
                                    conflictBasename: nil)
                    log.notice("fetchContents asset \(id, privacy: .public) ok bytes-at=\(localURL.path, privacy: .public)")
                    let parent = await Self.resolveAssetParent(meta: resolved, rootCache: self.rootCache)
                    completionHandler(localURL, MapleItem(assetMetadata: resolved, parent: parent), nil)
                    return
                case .sidecar(let assetID, let conflictBasename):
                    // Sidecar: preserve the `.xmp` extension on the
                    // materialized URL so the Quick Look extension can tell
                    // sidecars apart from RAWs by basename alone.
                    let localURL = tmpDir.appendingPathComponent(UUID().uuidString + ".xmp")
                    async let metaTask = catalog.getAsset(assetID: assetID)
                    async let bytesTask = catalog.getXMP(assetID: assetID, conflictBasename: conflictBasename)
                    let bytes = try await bytesTask
                    try bytes.write(to: localURL, options: .atomic)
                    let resolved = try await metaTask
                    guard let resolved else {
                        completionHandler(nil, nil, NSError(domain: NSFileProviderErrorDomain,
                                                            code: NSFileProviderError.noSuchItem.rawValue))
                        return
                    }
                    self.recordMeta(domain: self.domain.identifier.rawValue,
                                    localBasename: localURL.lastPathComponent,
                                    assetID: assetID,
                                    conflictBasename: conflictBasename)
                    // Construct a SIDECAR-shaped MapleItem so the returned
                    // item's `itemIdentifier` matches the request's
                    // `.sidecar(assetID:conflictBasename:)` shape. Building
                    // an `assetMetadata`-based item here would produce
                    // `.asset(id)` and the OS would associate the downloaded
                    // `.xmp` bytes with the RAW asset, breaking subsequent
                    // sidecar lookups and Quick Look discrimination.
                    let parentSidecar = await Self.resolveAssetParent(meta: resolved, rootCache: self.rootCache)
                    let imageBase: String = {
                        let f = resolved.filename
                        let dot = f.lastIndex(of: ".")
                        return dot.map { String(f[..<$0]) } ?? f
                    }()
                    // The on-disk filename the server will report is
                    // either `<imageBase>.xmp` (canonical) or
                    // `<conflictBasename>.xmp` (conflict copy). The
                    // `init(sidecar:parentImageBase:parentIdentifier:)`
                    // initializer reads `sidecar.name` to decide
                    // canonical-vs-conflict, so we synthesize the right
                    // name explicitly.
                    let sidecarName: String = {
                        if let cb = conflictBasename, !cb.isEmpty {
                            return "\(cb).xmp"
                        }
                        return "\(imageBase).xmp"
                    }()
                    let mtime = Date()
                    let synthesized = SidecarChild(
                        name: sidecarName,
                        path: sidecarName,
                        mtime: mtime,
                        size: Int64(bytes.count),
                        assetID: assetID
                    )
                    let sidecarItem = MapleItem(sidecar: synthesized,
                                                parentImageBase: imageBase,
                                                parentIdentifier: parentSidecar)
                    completionHandler(localURL, sidecarItem, nil)
                    return
                case .folder, .trash:
                    completionHandler(nil, nil, NSError(domain: NSFileProviderErrorDomain,
                                                        code: NSFileProviderError.noSuchItem.rawValue))
                    return
                }
            } catch {
                log.error("fetch failed: \(String(describing: error), privacy: .public)")
                completionHandler(nil, nil, error)
            }
        }
        return progress
    }

    // MARK: - Enumeration

    open func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier,
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
                                        listCache: listCache,
                                        rootCache: self.rootCache)
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

    open func createItem(basedOn itemTemplate: NSFileProviderItem,
                    fields: NSFileProviderItemFields,
                    contents url: URL?,
                    options: NSFileProviderCreateItemOptions = [],
                    request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        // filename / parent / contents path all carry user-visible
        // names; redact in non-debug logs. Identifier shape (the
        // `parent.rawValue` prefix `folder/`, `asset/`, etc.) is still
        // visible when the redacted suffix is decoded, which is enough
        // for log triage without surfacing the user's photo paths.
        log.notice("createItem filename=\(itemTemplate.filename, privacy: .private) parent=\(itemTemplate.parentItemIdentifier.rawValue, privacy: .private) contents=\(url?.path ?? "<nil>", privacy: .private)")
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
                // folderID is a server-side opaque ObjectId so it's
                // safe to surface; targetRel + bytes-from are user-
                // visible path/filename — redact.
                self.log.notice("upload start folderID=\(folderID, privacy: .public) target=\(targetRel, privacy: .private) bytes-from=\(contentsURL.path, privacy: .private)")
                let outcome = try await catalog.uploadFile(
                    folderID: folderID,
                    targetRelativePath: targetRel,
                    fileURL: contentsURL,
                    mtime: itemTemplate.contentModificationDate ?? nil,
                )
                self.log.notice("upload outcome=\(String(describing: outcome), privacy: .public)")
                switch outcome {
                case .ok(let resp):
                    // The server-stat'd `size` and `mtime` are authoritative;
                    // the local file may have been truncated/modified between
                    // upload and this completion handler. Don't stat the
                    // local stash again.
                    let ext = (filename as NSString).pathExtension.lowercased()
                    let image = ImageChild(
                        name: filename,
                        path: resp.absPath,
                        mtime: resp.mtime,
                        size: resp.size,
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

    open func modifyItem(_ item: NSFileProviderItem,
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
        // changes. Anything else (rename + reparent in one shot, in-place
        // modify) falls through to featureUnsupported.
        //
        // Tighten: require .parentItemIdentifier to be the ONLY changed
        // field. A bare `.contains(.parentItemIdentifier)` check would
        // let Finder smuggle a rename-during-restore through (out of
        // Phase 3 scope) — `item.filename` would then be sent to the
        // server as the target basename.
        if case .asset(let assetID) = parsed,
           changedFields == [.parentItemIdentifier] {
            let newParentID = item.parentItemIdentifier
            let newParentParsed: FileProviderIdentifier
            do { newParentParsed = try FileProviderIdentifier(rawValue: newParentID.rawValue) }
            catch {
                completionHandler(nil, [], false,
                    NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
                return Progress()
            }
            // Phase 3 only restores into a normal folder under the SAME library.
            // The folderID is forwarded to the server so it can reject
            // cross-library restores (the file is moved using the asset's
            // original library root; restoring into a different library
            // would silently land in the wrong place).
            guard case .folder(let newFolderID, let newRelative) = newParentParsed else {
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
                    let resp = try await catalog.restoreAsset(
                        assetID: assetID,
                        targetRelativePath: targetRel,
                        targetFolderID: newFolderID,
                    )
                    // `resp.absPath` is the SERVER's filesystem path, not
                    // a path on this Mac — statting it returns nil/throws,
                    // which is why size + mtime + filename are now returned
                    // authoritatively in the response.
                    let ext = (resp.filename as NSString).pathExtension.lowercased()
                    let image = ImageChild(
                        name: resp.filename,
                        path: resp.absPath,
                        mtime: resp.mtime,
                        size: resp.size,
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
        // Decode the prior mtime from the version's contentVersion field.
        // Format: "<epoch>-<identifier>" (see `MapleItem.itemVersion`).
        // The dedicated helper extracts the epoch prefix so a format
        // change to the seed body doesn't break the XMP write
        // precondition.
        let priorMtime = MapleItem.decodePriorMtime(version.contentVersion)
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

    open func deleteItem(identifier: NSFileProviderItemIdentifier,
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
        let canonicalBase = Self.canonicalBase(forSidecarFilename: filename)
        // Stream pages and early-return on match so a folder with thousands
        // of images doesn't get fully buffered into memory just to look up
        // one sidecar's paired assetID.
        return try await Self.findAssetID(
            catalog: catalog,
            absolutePath: absolutePath,
            canonicalBase: canonicalBase,
            log: log
        )
    }

    /// Pages through `catalog.listDir(absolutePath:cursor:limit:)`, returning
    /// the first image whose filename-base matches `canonicalBase` (and has
    /// a non-nil `assetID`), or nil after walking up to `itemLookupMaxPages`
    /// pages. Internal so tests can drive it directly through a stubbed
    /// catalog.
    static func findAssetID(catalog: RemoteCatalog,
                            absolutePath: String,
                            canonicalBase: String,
                            log: Logger? = nil) async throws -> String? {
        var cursor: String? = nil
        var pageGuard = 0
        repeat {
            let page = try await catalog.listDir(absolutePath: absolutePath,
                                                 cursor: cursor,
                                                 limit: itemLookupPageLimit)
            for img in page.images {
                guard let assetID = img.assetID else { continue }
                let dot = img.name.lastIndex(of: ".")
                let imgBase = dot.map { String(img.name[..<$0]) } ?? img.name
                if imgBase == canonicalBase { return assetID }
            }
            cursor = page.nextCursor
            pageGuard += 1
            if pageGuard > itemLookupMaxPages {
                log?.error("findAssetID page guard tripped at \(pageGuard) pages for \(absolutePath, privacy: .public)")
                break
            }
        } while cursor != nil
        return nil
    }

    /// Derive the FP parent identifier for an asset from its server
    /// metadata. Strips the matching library-root prefix off `absPath`
    /// and returns `.folder(folderID, parentRelativePath)`.
    ///
    /// Fallbacks — NEVER `.workingSet`. Routing to the working-set
    /// container forces the OS to `item(for: .workingSet)`, which now
    /// returns `noSuchItem` (the container is hidden), and that breaks
    /// materialization. Instead:
    ///   - folderID is in roots but absPath prefix mismatch (server bug
    ///     or out-of-tree asset): fall back to the library root —
    ///     `.folder(folderID, "")` — which the rest of the codebase
    ///     guarantees exists.
    ///   - folderID itself isn't in roots (domain unregistered, race
    ///     against root cache invalidation): fall back to
    ///     `.rootContainer`. Uglier — the asset surfaces alongside the
    ///     library roots instead of inside one — but the identifier is
    ///     always valid and materialization completes.
    static func resolveAssetParent(meta: AssetMetadata,
                                    rootCache: LibraryRootCache?) async -> NSFileProviderItemIdentifier {
        guard let rootCache,
              let roots = try? await rootCache.roots(),
              let root = roots.first(where: { $0.id == meta.folderID }) else {
            return .rootContainer
        }
        // absPath e.g. "/srv/photos/Library/2026/Adam/04-02/IMG.jpg"
        // root.path e.g. "/srv/photos/Library"
        // -> relative = "2026/Adam/04-02/IMG.jpg"
        // -> parent   = "2026/Adam/04-02"
        let rootWithSlash = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard meta.absPath.hasPrefix(rootWithSlash) else {
            // absPath doesn't fall under the resolved root — likely a
            // server bug. The library root itself is always valid.
            let rootIdent = FileProviderIdentifier.folder(folderID: meta.folderID,
                                                           relativePath: "")
            return NSFileProviderItemIdentifier(rootIdent.rawValue)
        }
        let relative = String(meta.absPath.dropFirst(rootWithSlash.count))
        let parentRelative = (relative as NSString).deletingLastPathComponent
        let parentID = FileProviderIdentifier.folder(folderID: meta.folderID,
                                                       relativePath: parentRelative)
        return NSFileProviderItemIdentifier(parentID.rawValue)
    }

    /// Pages through `catalog.listDir(absolutePath:cursor:limit:)`, returning
    /// the first `DirChild` whose `name` matches `childName`, or nil if the
    /// child is not present after walking up to `itemLookupMaxPages` pages.
    /// Internal so tests can drive it directly through a stubbed catalog.
    static func findChildDir(catalog: RemoteCatalog,
                             absolutePath: String,
                             childName: String,
                             log: Logger? = nil) async throws -> DirChild? {
        var cursor: String? = nil
        var pageGuard = 0
        repeat {
            let page = try await catalog.listDir(absolutePath: absolutePath,
                                                 cursor: cursor,
                                                 limit: itemLookupPageLimit)
            if let hit = page.dirs.first(where: { $0.name == childName }) {
                return hit
            }
            cursor = page.nextCursor
            pageGuard += 1
            if pageGuard > itemLookupMaxPages {
                log?.error("findChildDir page guard tripped at \(pageGuard) pages for \(absolutePath, privacy: .public)")
                break
            }
        } while cursor != nil
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
public final class DeferredFolderEnumerator: NSObject, NSFileProviderEnumerator {
    private let catalog: RemoteCatalog
    private let rootCache: LibraryRootCache
    private let folderID: String
    private let relativePath: String
    private let containerIdentifier: NSFileProviderItemIdentifier
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "enumerator")

    public init(catalog: RemoteCatalog,
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

    public func invalidate() {}

    public func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
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

    public func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    public func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
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
    // macOS Sequoia/Tahoe rejects items whose itemVersion uses the
    // protocol default (empty bytes) with `__FILEPROVIDER_BAD_ITEM_MISSING_ITEMVERSION__`.
    // Root container is immutable; stable version is fine.
    var itemVersion: NSFileProviderItemVersion {
        let bytes = Data("root-v1".utf8)
        return .init(contentVersion: bytes, metadataVersion: bytes)
    }
}

/// Synthetic item for the working-set container. `MapleItem(assetMetadata:)`
/// reports its parent as `.workingSet`, so the OS calls `item(for: .workingSet)`
/// to validate the container; without this stub the parser threw
/// `invalidPrefix` and the OS retried materialization in a loop.
private final class WorkingSetContainerItem: NSObject, NSFileProviderItem {
    var itemIdentifier: NSFileProviderItemIdentifier { .workingSet }
    // Self-parent + empty capabilities so Finder doesn't surface a
    // "Working Set" folder under the library root. The container still
    // exists for the OS (item(for: .workingSet) needs to succeed so
    // items whose parent is .workingSet can be validated), but it's not
    // browsable from Finder.
    var parentItemIdentifier: NSFileProviderItemIdentifier { .workingSet }
    var filename: String { ".workingset" }
    var contentType: UTType { .folder }
    var capabilities: NSFileProviderItemCapabilities { [] }
    var itemVersion: NSFileProviderItemVersion {
        let bytes = Data("workingset-v1".utf8)
        return .init(contentVersion: bytes, metadataVersion: bytes)
    }
}

public final class EmptyEnumerator: NSObject, NSFileProviderEnumerator {
    public override init() { super.init() }
    public func invalidate() {}
    public func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        observer.didEnumerate([])
        observer.finishEnumerating(upTo: nil)
    }
    public func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }
    public func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("0".utf8)))
    }
}
