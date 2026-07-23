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
        let session = URLSession(configuration: .default)
        let domainID = domain.identifier.rawValue
        let http = AuthenticatedHTTPClient(
            server: cfg.serverURL,
            urlSession: session,
            tokensProvider: { try? TokenStore.load(server: cfg.serverURL) },
            onTokensRefreshed: { try TokenStore.save($0, server: cfg.serverURL) },
            onSignOut: { TokenStore.clear(server: cfg.serverURL) }
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
            http: http,
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
        // Separate sandboxed process from the main app and MapleBackupAgent
        // — no access to either's in-memory LocalNetworkResolver cache, and
        // this synchronous `init` (required by NSFileProviderReplicatedExtension)
        // can't block on a network round-trip to resolve one inline. Kick
        // off a non-blocking probe instead: `catalog` starts on the identity
        // URL (correct immediately) and swaps to the LAN address, if any, once
        // resolution completes — every request issued before then simply
        // goes out over the identity URL, matching today's behavior.
        Task { [catalog] in
            let effective = await LocalNetworkResolving.resolveEffectiveURL(identity: cfg.serverURL)
            await catalog.updateServer(effective)
        }
        let hasTokens = (try? TokenStore.load(server: cfg.serverURL)) != nil
        log.notice("init domain=\(domain.identifier.rawValue, privacy: .public) serverURL=\(cfg.serverURL.absoluteString, privacy: .public) hasTokens=\(hasTokens, privacy: .public) device=\(resolvedDeviceName, privacy: .public)")
        if !hasTokens {
            log.error("EXTENSION HAS NO AUTH TOKENS — host app must be signed in for this server. Open Maple, sign in, then the extension will pick them up on next launch.")
        }
    }

    private func notAuthenticatedError() -> NSError {
        NSError(domain: NSFileProviderErrorDomain,
                code: NSFileProviderError.notAuthenticated.rawValue)
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
                case .file(let folderID, let relativePath):
                    // Non-indexed file resolved by its library-relative path.
                    // Stat for size/mtime; reattach under its parent folder.
                    // nil means a genuine 404 → noSuchItem; a thrown error is
                    // transient (network/auth/5xx) and is propagated so Finder
                    // surfaces the real failure instead of silently evicting.
                    do {
                        guard let meta = try await catalog.statFile(folderID: folderID,
                                                                    relativePath: relativePath) else {
                            completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                                           code: NSFileProviderError.noSuchItem.rawValue))
                            return
                        }
                        let parentRel = (relativePath as NSString).deletingLastPathComponent
                        let parentRaw = FileProviderIdentifier
                            .folder(folderID: folderID, relativePath: parentRel)
                            .rawValue
                        let parentID = NSFileProviderItemIdentifier(parentRaw)
                        completionHandler(MapleItem(file: meta, folderID: folderID,
                                                    relativePath: relativePath,
                                                    parentIdentifier: parentID), nil)
                    } catch {
                        log.error("statFile item(for:) failed: \(error.localizedDescription, privacy: .public)")
                        completionHandler(nil, error)
                    }
                case .sidecar:
                    // Sidecar item lookup not yet supported; the OS receives items via
                    // folder enumeration.
                    completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                                   code: NSFileProviderError.noSuchItem.rawValue))
                case .mapleDir(let folderID, let parentRelativePath):
                    // Synthetic `.maple/` directory. The identifier
                    // self-describes everything we need; resolution is
                    // a constructor call (no server round-trip).
                    let parentRaw = FileProviderIdentifier
                        .folder(folderID: folderID, relativePath: parentRelativePath)
                        .rawValue
                    let parentID = NSFileProviderItemIdentifier(parentRaw)
                    completionHandler(MapleItem(
                        mapleDir: folderID,
                        parentRelativePath: parentRelativePath,
                        parentIdentifier: parentID
                    ), nil)
                case .mapleThumbsDir(let folderID, let parentRelativePath):
                    // Parent is the synthesized `.maple/` directory at
                    // the same `parentRelativePath`.
                    let parentRaw = FileProviderIdentifier
                        .mapleDir(folderID: folderID, parentRelativePath: parentRelativePath)
                        .rawValue
                    let parentID = NSFileProviderItemIdentifier(parentRaw)
                    completionHandler(MapleItem(
                        mapleThumbsDir: folderID,
                        parentRelativePath: parentRelativePath,
                        parentIdentifier: parentID
                    ), nil)
                case .thumb(let assetID):
                    // Resolve via the asset metadata so we can compute
                    // the on-disk thumb filename (`sha256_prefix16` of
                    // the RAW basename) and reattach the item under
                    // its correct `.maple/thumbs/` parent.
                    //
                    // `resolveThumbParent` throws on every failure mode
                    // (rootCache.roots() throws, folderID not in roots,
                    // absPath off-tree) so a wrongly-parented thumb is
                    // never synthesized. Earlier shape used
                    // `try? await rootCache.roots() ?? []` which
                    // silently degraded a network failure into "no
                    // matching root" and attached the thumb to a thumbs
                    // container at the library root, displacing it from
                    // its real folder.
                    do {
                        guard let meta = try await catalog.getAsset(assetID: assetID) else {
                            completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                                           code: NSFileProviderError.noSuchItem.rawValue))
                            return
                        }
                        let parentID = try await Self.resolveThumbParent(meta: meta, rootCache: rootCache)
                        let thumbName = MapleThumbCacheKey.thumbFilename(forRawBasename: meta.filename)
                        completionHandler(MapleItem(
                            thumbForAsset: assetID,
                            displayFilename: thumbName,
                            parentIdentifier: parentID
                        ), nil)
                    } catch {
                        log.error("thumb item(for:) failed: \(error.localizedDescription, privacy: .public)")
                        completionHandler(nil, error)
                    }
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
                    // Stamp the downloaded file's mtime to match the
                    // asset's server-side mtime. Without this, the file
                    // hits disk with mtime = "now" (whatever URLSession
                    // wrote), the MapleItem we return has
                    // contentModificationDate = server mtime — the OS
                    // compares and decides the local file is newer than
                    // the item, then fires modifyItem to push the
                    // "local edit" back. That path isn't supported for
                    // RAW bytes and surfaces in Finder as an up-arrow
                    // sync error.
                    do {
                        try FileManager.default.setAttributes(
                            [.modificationDate: resolved.contentModificationDate],
                            ofItemAtPath: localURL.path
                        )
                    } catch {
                        // Non-fatal — the download still succeeded. But
                        // a silent failure here means a subsequent
                        // up-arrow sync error has no obvious cause, so
                        // log it (notice, not error: the bytes are
                        // good, the user-facing operation completed).
                        log.notice("setAttributes(modificationDate:) failed for \(localURL.lastPathComponent, privacy: .public): \(String(describing: error), privacy: .public)")
                    }
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
                    // Match the file's mtime to the asset's server mtime
                    // so the OS doesn't think the sidecar was edited
                    // locally and try to push it back via modifyItem.
                    // (Same root cause as the RAW path above.)
                    do {
                        try FileManager.default.setAttributes(
                            [.modificationDate: resolved.contentModificationDate],
                            ofItemAtPath: localURL.path
                        )
                    } catch {
                        // Non-fatal — the download still succeeded. But
                        // a silent failure here means a subsequent
                        // up-arrow sync error has no obvious cause, so
                        // log it (notice, not error: the bytes are
                        // good, the user-facing operation completed).
                        log.notice("setAttributes(modificationDate:) failed for \(localURL.lastPathComponent, privacy: .public): \(String(describing: error), privacy: .public)")
                    }
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
                    // Use the resolved asset's server-side mtime so the
                    // synthesized SidecarChild — and therefore the
                    // MapleItem's contentModificationDate — agrees with
                    // the file mtime we stamp a few lines down. Falling
                    // back to "now" here would reintroduce the OS's
                    // file-vs-item mtime mismatch in the inverted
                    // direction: file = server-mtime, item = now.
                    let mtime = resolved.contentModificationDate
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
                case .thumb(let assetID):
                    // Pre-rendered thumbnail AVIF from the server's
                    // `.maple/thumbs/` cache. Surfaced through the FP
                    // mount so the app's future Folder-View consumer
                    // (#101) can read these next to the photos. Bytes
                    // are pass-through from `GET /api/assets/<id>/thumb`,
                    // which serves the same on-disk file the server
                    // wrote at `resolveThumbPath(raw)`.
                    //
                    // The materialized URL keeps the `.avif` extension
                    // so any downstream consumer (Quick Look, the app
                    // reader) can identify it by basename.
                    let localURL = tmpDir.appendingPathComponent(UUID().uuidString + ".avif")
                    async let metaTask = catalog.getAsset(assetID: assetID)
                    async let bytesTask = catalog.getThumb(assetID: assetID)
                    let bytes = try await bytesTask
                    try bytes.write(to: localURL, options: .atomic)
                    let resolved = try await metaTask
                    // If the underlying asset is gone (server deleted,
                    // never indexed) there's nothing meaningful to hand
                    // back: the earlier shape fabricated an item parented
                    // at `.workingSet`, but the OS no longer treats
                    // `.workingSet` as a real container (see
                    // `resolveAssetParent`'s NEVER `.workingSet` clause
                    // from PR #79's review fixes). Surface noSuchItem so
                    // the OS evicts the stranded thumb from its cache.
                    guard let resolved else {
                        log.notice("fetchContents thumb \(assetID, privacy: .public) — getAsset returned nil; underlying asset gone")
                        completionHandler(nil, nil, NSError(domain: NSFileProviderErrorDomain,
                                                            code: NSFileProviderError.noSuchItem.rawValue))
                        return
                    }
                    let thumbName = MapleThumbCacheKey.thumbFilename(forRawBasename: resolved.filename)
                    let parentIdent = try await Self.resolveThumbParent(meta: resolved,
                                                                        rootCache: self.rootCache)
                    let item = MapleItem(
                        thumbForAsset: assetID,
                        displayFilename: thumbName,
                        parentIdentifier: parentIdent
                    )
                    log.notice("fetchContents thumb \(assetID, privacy: .public) ok bytes=\(bytes.count, privacy: .public)")
                    completionHandler(localURL, item, nil)
                    return
                case .file(let folderID, let relativePath):
                    // Non-indexed file: stream the bytes by path and stat in
                    // parallel (the OS requires a non-nil item alongside the
                    // URL). Materialize under a basename that keeps the
                    // original extension so Quick Look can identify it.
                    let ext = (relativePath as NSString).pathExtension
                    let localName = ext.isEmpty ? UUID().uuidString : "\(UUID().uuidString).\(ext)"
                    let localURL = tmpDir.appendingPathComponent(localName)
                    async let metaTask = catalog.statFile(folderID: folderID, relativePath: relativePath)
                    async let downloadTask: Void = catalog.downloadFile(folderID: folderID,
                                                                        relativePath: relativePath,
                                                                        to: localURL)
                    _ = try await downloadTask
                    guard let meta = try await metaTask else {
                        completionHandler(nil, nil, NSError(domain: NSFileProviderErrorDomain,
                                                            code: NSFileProviderError.noSuchItem.rawValue))
                        return
                    }
                    do {
                        try FileManager.default.setAttributes(
                            [.modificationDate: meta.mtime], ofItemAtPath: localURL.path)
                    } catch {
                        log.notice("setAttributes(modificationDate:) failed for \(localURL.lastPathComponent, privacy: .public): \(String(describing: error), privacy: .public)")
                    }
                    let parentRel = (relativePath as NSString).deletingLastPathComponent
                    let parentRaw = FileProviderIdentifier
                        .folder(folderID: folderID, relativePath: parentRel)
                        .rawValue
                    let parentID = NSFileProviderItemIdentifier(parentRaw)
                    log.notice("fetchContents file \(relativePath, privacy: .private) ok bytes-at=\(localURL.path, privacy: .public)")
                    completionHandler(localURL, MapleItem(file: meta, folderID: folderID,
                                                          relativePath: relativePath,
                                                          parentIdentifier: parentID), nil)
                    return
                case .folder, .trash, .mapleDir, .mapleThumbsDir:
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
        case .file:
            // Non-indexed files are leaf items, not containers.
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
        case .mapleDir(let folderID, let parentRelativePath):
            return MapleDirEnumerator(folderID: folderID,
                                      parentRelativePath: parentRelativePath,
                                      containerIdentifier: containerItemIdentifier)
        case .mapleThumbsDir(let folderID, let parentRelativePath):
            // Resolve the parent folder's server-side absolute path
            // through the cached library roots, then drive the same
            // `catalog.listDir(...)` the FolderEnumerator uses to walk
            // the parent's image list and synthesize one thumb item
            // per indexed image.
            return DeferredMapleThumbsEnumerator(catalog: catalog,
                                                  rootCache: rootCache,
                                                  folderID: folderID,
                                                  parentRelativePath: parentRelativePath,
                                                  containerIdentifier: containerItemIdentifier)
        case .thumb:
            // Thumbs are leaf items, not containers — cannot be enumerated.
            throw NSError(domain: NSFileProviderErrorDomain,
                          code: NSFileProviderError.noSuchItem.rawValue)
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
        // Folder creation. Finder fires this for "New Folder" in the FP
        // mount and for the folder-create that precedes a drag-in of a
        // folder full of files (the OS recursively walks the source,
        // creating each subdirectory before the files inside it). The
        // contentType check goes BEFORE the extension-based routing
        // because the OS, not the filename, decides whether the
        // template is a directory.
        if itemTemplate.contentType?.conforms(to: .folder) == true {
            return createFolderItem(basedOn: itemTemplate, catalog: catalog, completionHandler: completionHandler)
        }

        let filename = itemTemplate.filename
        let dot = filename.lastIndex(of: ".")
        let ext = dot.map { String(filename[filename.index(after: $0)...]).lowercased() } ?? ""

        // Phase 2 path: XMP sidecar create.
        if ext == "xmp" {
            return createXMPItem(basedOn: itemTemplate, contents: url, catalog: catalog, completionHandler: completionHandler)
        }

        // Any other file — image or not — goes through the upload path. The
        // server stores every file type and decides whether to index it
        // (image-only): an image comes back with an asset id and surfaces as
        // an `.asset` item; everything else comes back without one and
        // surfaces as a path-addressed `.file` item (see uploadItem).
        return uploadItem(basedOn: itemTemplate, contents: url, catalog: catalog, completionHandler: completionHandler)
    }

    /// Create a subdirectory inside a library root (or a deeper folder
    /// thereof). Delegates the actual `mkdir` to the server and
    /// synthesizes a `MapleItem` for the new folder. Without this branch,
    /// Finder's folder-create returned featureUnsupported and the entire
    /// drag-in of a folder containing files aborted before any child
    /// upload was attempted.
    private func createFolderItem(basedOn itemTemplate: NSFileProviderItem,
                                  catalog: RemoteCatalog,
                                  completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let parentID = itemTemplate.parentItemIdentifier
        let parsed: FileProviderIdentifier
        do { parsed = try FileProviderIdentifier(rawValue: parentID.rawValue) }
        catch {
            completionHandler(nil, [], false,
                NSError(domain: NSFileProviderErrorDomain,
                        code: NSFileProviderError.noSuchItem.rawValue))
            return Progress()
        }
        // Folders can only be created inside a library root or one of
        // its subdirectories. Trash containers, root container,
        // synthetic `.maple/` paths all reject.
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
                self.log.notice("mkdir folderID=\(folderID, privacy: .public) target=\(targetRel, privacy: .private)")
                let resp = try await catalog.makeDir(folderID: folderID, targetRelativePath: targetRel)
                // Server doesn't return an mtime — synthesize `now`. The
                // OS will reconcile against the real mtime on the next
                // parent enumeration (signalled below).
                let dir = DirChild(name: filename, path: resp.absPath, mtime: Date())
                let item = MapleItem(
                    subdirectory: dir,
                    parentFolderID: folderID,
                    parentRelativePath: parentRelative,
                    parentIdentifier: parentID
                )
                completionHandler(item, [], false, nil)
                await self.signalEnumeratorReload(parent: parentID)
            } catch {
                self.log.error("mkdir failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(nil, [], false, error)
            }
        }
        return progress
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
                    if let assetID = resp.assetID {
                        // Image — indexed, surfaces as an `.asset` item.
                        let image = ImageChild(
                            name: filename,
                            path: resp.absPath,
                            mtime: resp.mtime,
                            size: resp.size,
                            ext: ext,
                            assetID: assetID
                        )
                        if let item = MapleItem(image: image, parentIdentifier: parentID) {
                            completionHandler(item, [], false, nil)
                        } else {
                            completionHandler(nil, [], false,
                                NSError(domain: NSFileProviderErrorDomain,
                                        code: NSFileProviderError.noSuchItem.rawValue))
                        }
                    } else {
                        // Non-indexed file (video, document, extensionless, …):
                        // stored + synced, addressed by its library-relative
                        // path rather than an asset id.
                        let file = FileChild(
                            name: filename,
                            path: resp.absPath,
                            mtime: resp.mtime,
                            size: resp.size,
                            ext: ext
                        )
                        completionHandler(MapleItem(file: file, folderID: folderID,
                                                    relativePath: targetRel,
                                                    parentIdentifier: parentID), [], false, nil)
                    }
                    await self.signalEnumeratorReload(parent: parentID)
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

        // Folder rename / move. The folder identifier encodes its path
        // (`folder/<libraryID>:<b64(relativePath)>`), so a rename or move
        // changes this folder's identifier and every descendant's. We push
        // the rename to the server, return a freshly-built item carrying the
        // NEW path-derived identifier, and signal a re-enumeration of the
        // affected parents so the OS rebuilds descendant identifiers.
        //
        // Only same-library moves are supported: the new parent's library
        // folder ID must match this folder's. Anything beyond filename/parent
        // (and cross-library moves) falls through to featureUnsupported.
        if case .folder(let folderID, let sourceRelative) = parsed {
            let renameOrMove: NSFileProviderItemFields = [.filename, .parentItemIdentifier]
            guard !changedFields.intersection(renameOrMove).isEmpty,
                  changedFields.isSubset(of: renameOrMove) else {
                completionHandler(nil, [], false,
                    NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
                return Progress()
            }
            let newParentID = item.parentItemIdentifier
            let newParentParsed: FileProviderIdentifier
            do { newParentParsed = try FileProviderIdentifier(rawValue: newParentID.rawValue) }
            catch {
                completionHandler(nil, [], false,
                    NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
                return Progress()
            }
            guard case .folder(let newFolderID, let newParentRelative) = newParentParsed,
                  newFolderID == folderID else {
                completionHandler(nil, [], false,
                    NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
                return Progress()
            }
            let filename = item.filename
            let targetRelative = newParentRelative.isEmpty ? filename : "\(newParentRelative)/\(filename)"
            let progress = Progress(totalUnitCount: 1)
            Task {
                defer { progress.completedUnitCount = 1 }
                do {
                    self.log.notice("folder move folderID=\(folderID, privacy: .public) source=\(sourceRelative, privacy: .private) target=\(targetRelative, privacy: .private)")
                    let result = try await catalog.moveFolder(
                        folderID: folderID,
                        sourceRelativePath: sourceRelative,
                        targetRelativePath: targetRelative
                    )
                    switch result {
                    case .conflict:
                        completionHandler(nil, [], false,
                            NSError(domain: NSFileProviderErrorDomain,
                                    code: NSFileProviderError.filenameCollision.rawValue))
                        return
                    case .ok(let resp):
                        let dir = DirChild(name: filename, path: resp.absPath, mtime: Date())
                        let moved = MapleItem(
                            subdirectory: dir,
                            parentFolderID: folderID,
                            parentRelativePath: newParentRelative,
                            parentIdentifier: newParentID
                        )
                        completionHandler(moved, [], false, nil)
                        // The folder's identifier (and its descendants') moved
                        // with the path. Reload the new parent so the OS
                        // re-enumerates the subtree under its new identifiers;
                        // reload the old parent too on a cross-folder move so
                        // its stale entry drops.
                        await self.signalEnumeratorReload(parent: newParentID)
                        let oldParentRelative: String = {
                            guard let slash = sourceRelative.lastIndex(of: "/") else { return "" }
                            return String(sourceRelative[..<slash])
                        }()
                        let oldParentID = NSFileProviderItemIdentifier(
                            FileProviderIdentifier.folder(folderID: folderID,
                                                           relativePath: oldParentRelative).rawValue)
                        if oldParentID != newParentID {
                            await self.signalEnumeratorReload(parent: oldParentID)
                        }
                    }
                } catch {
                    self.log.error("folder move failed: \(error.localizedDescription, privacy: .public)")
                    completionHandler(nil, [], false, error)
                }
            }
            return progress
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

        // Asset, but not a restore: accept benign metadata-only edits
        // silently. After fetchContents materialises a RAW, the OS often
        // surfaces a modifyItem call carrying `.lastUsedDate`,
        // `.extendedAttributes` (quarantine, Spotlight metadata), Finder
        // `.tagData`, or `.favoriteRank` — none of which the Maple server
        // tracks. Returning featureUnsupported here makes Finder badge
        // every freshly-opened RAW with a persistent "upload error". Echo
        // the input item back instead so the OS records the local
        // metadata change without re-trying.
        //
        // Genuine in-place edits (changedFields ⊇ `.contents`), renames
        // (`.filename`), and moves (`.parentItemIdentifier`) still fall
        // through to featureUnsupported — those operations would silently
        // drop user work if accepted, so a clear error is correct.
        if case .asset = parsed {
            let unsupportedAssetFields: NSFileProviderItemFields =
                [.contents, .filename, .parentItemIdentifier]
            if changedFields.intersection(unsupportedAssetFields).isEmpty {
                completionHandler(item, [], false, nil)
                return Progress()
            }
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
                case .folder, .trash, .mapleDir, .mapleThumbsDir, .thumb, .file:
                    // Synthetic `.maple/` items + thumbs are read-only, and
                    // non-indexed files are read-only in v1 (no path-addressed
                    // delete/trash endpoint yet) — deletes are unsupported.
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
        // `FileProviderMount.relativePath` owns the prefix-strip shape
        // so this helper and the app's mount-path resolver agree.
        guard let relative = FileProviderMount.relativePath(under: root.path, of: meta.absPath) else {
            // absPath doesn't fall under the resolved root — likely a
            // server bug. The library root itself is always valid.
            let rootIdent = FileProviderIdentifier.folder(folderID: meta.folderID,
                                                           relativePath: "")
            return NSFileProviderItemIdentifier(rootIdent.rawValue)
        }
        let parentRelative = (relative as NSString).deletingLastPathComponent
        let parentID = FileProviderIdentifier.folder(folderID: meta.folderID,
                                                       relativePath: parentRelative)
        return NSFileProviderItemIdentifier(parentID.rawValue)
    }

    /// Derive the `.maple/thumbs/` parent identifier for a thumb item
    /// from its underlying asset's metadata. Unlike `resolveAssetParent`
    /// which falls back to a valid (though uglier) identifier when the
    /// library roots can't be resolved, this helper THROWS on every
    /// failure mode so callers route the error back to the OS instead
    /// of synthesizing an item under a bad parent.
    ///
    /// Rationale: a thumb only exists as a child of a `.mapleThumbsDir`
    /// container whose `parentRelativePath` agrees with the underlying
    /// asset's folder. Picking the wrong parent (empty path when the
    /// asset lives several directories deep) attaches the thumb to a
    /// container the OS cannot reconcile against any enumeration, and
    /// `.workingSet` is no longer accepted as a fallback parent (see
    /// `resolveAssetParent`'s NEVER `.workingSet` clause). So:
    ///   - `rootCache.roots()` throws — propagate the error so the OS
    ///     retries instead of silently producing a wrongly-parented item.
    ///   - `meta.folderID` not in roots — throw `noSuchItem`; the thumb
    ///     genuinely has no resolvable parent.
    ///   - `absPath` not under the resolved root — throw `noSuchItem`;
    ///     same rationale, no valid parent identifier exists.
    static func resolveThumbParent(meta: AssetMetadata,
                                    rootCache: LibraryRootCache?) async throws -> NSFileProviderItemIdentifier {
        guard let rootCache else {
            throw NSError(domain: NSFileProviderErrorDomain,
                          code: NSFileProviderError.noSuchItem.rawValue)
        }
        let roots = try await rootCache.roots()
        guard let root = roots.first(where: { $0.id == meta.folderID }) else {
            throw NSError(domain: NSFileProviderErrorDomain,
                          code: NSFileProviderError.noSuchItem.rawValue)
        }
        guard let relative = FileProviderMount.relativePath(under: root.path, of: meta.absPath) else {
            throw NSError(domain: NSFileProviderErrorDomain,
                          code: NSFileProviderError.noSuchItem.rawValue)
        }
        let parentRelative = (relative as NSString).deletingLastPathComponent
        let parentID = FileProviderIdentifier
            .mapleThumbsDir(folderID: meta.folderID,
                            parentRelativePath: parentRelative)
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

/// Resolves `folderID + parentRelativePath` -> absolute path on
/// first `enumerateItems` using the cached library-roots list, then
/// delegates to `MapleThumbsEnumerator`. Mirrors the deferred-resolve
/// shape used for the folder enumerator so the OS doesn't get an
/// abstract identifier it has to materialise per-page.
public final class DeferredMapleThumbsEnumerator: NSObject, NSFileProviderEnumerator {
    private let catalog: RemoteCatalog
    private let rootCache: LibraryRootCache
    private let folderID: String
    private let parentRelativePath: String
    private let containerIdentifier: NSFileProviderItemIdentifier
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "enumerator")

    public init(catalog: RemoteCatalog,
                rootCache: LibraryRootCache,
                folderID: String,
                parentRelativePath: String,
                containerIdentifier: NSFileProviderItemIdentifier) {
        self.catalog = catalog
        self.rootCache = rootCache
        self.folderID = folderID
        self.parentRelativePath = parentRelativePath
        self.containerIdentifier = containerIdentifier
    }

    public func invalidate() {}

    public func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            do {
                let roots = try await rootCache.roots()
                guard let root = roots.first(where: { $0.id == folderID }) else {
                    // Resolved library root vanished — treat as an
                    // empty `.maple/thumbs/` rather than failing. The
                    // root may reappear on the next enumeration; an
                    // empty list is the safe representation in the
                    // meantime.
                    observer.didEnumerate([])
                    observer.finishEnumerating(upTo: nil)
                    return
                }
                let absolutePath = parentRelativePath.isEmpty ? root.path : "\(root.path)/\(parentRelativePath)"
                let inner = MapleThumbsEnumerator(
                    catalog: catalog,
                    folderID: folderID,
                    parentAbsolutePath: absolutePath,
                    containerIdentifier: containerIdentifier
                )
                inner.enumerateItems(for: observer, startingAt: page)
            } catch {
                log.error("deferred maple thumbs enumerate failed: \(error.localizedDescription, privacy: .public)")
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
