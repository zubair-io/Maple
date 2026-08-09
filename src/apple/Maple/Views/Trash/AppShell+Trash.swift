// AppShell+Trash.swift — Delete key / context menu asset trash + restore
// (#2653), completing the platform split the merged `MapleCore` primitives
// already implement (`LocalFileOperations+Trash`, `SMBFileOperations+Trash`)
// and the Cloud primitives already implement (`RemoteCatalog.deleteAsset`/
// `restoreAsset`/`listTrash`).
//
// Routing mirrors `AppShell+AssetDrop.swift`'s shape one-for-one — same
// catalog-then-primaryURL-then-SMB source-kind dispatch, same per-item
// outcome bookkeeping, same "silent on an all-clean batch" report gate —
// deliberately, so the two multi-select batch flows read as one pattern:
//
//   macOS Filesystem → `FileManager.trashItem` (the real OS Trash — no
//     in-app Trash node for it; Finder is the UI, per the design doc's
//     "Delete → Trash → Restore" platform asymmetry).
//   iOS/iPadOS Filesystem + SMB → `.maple/trash/<rel>`, which DOES get an
//     in-app Trash node (`TrashBrowserSheet`).
//   Cloud → `DELETE /api/assets/<id>` (server-side trash).
//   PhotoKit → not supported; a visible reason, not a silent no-op.

import SwiftUI
import MapleCore

@MainActor
extension AppShell {

    // MARK: - Entry points

    /// Delete key / "Move to Trash" context-menu item on the grid. `ids ==
    /// nil` means "use the current grid selection" — same contract as
    /// `handleAssetDrop`.
    func trashSelectedAssets(ids: Set<AssetRef.ID>? = nil) {
        let resolved = ids.map(Array.init) ?? currentGridSelectionIDs()
        guard !resolved.isEmpty, assetTrashTask == nil else { return }

        var assetsByID: [AssetRef.ID: AssetRef] = [:]
        assetsByID.reserveCapacity(browseVM.assets.count)
        for asset in browseVM.assets where assetsByID[asset.id] == nil {
            assetsByID[asset.id] = asset
        }
        let targets = resolved.compactMap { assetsByID[$0] }
        guard !targets.isEmpty else { return }

        assetTrashTask = Task { @MainActor in
            var results: [AssetTrashItemResult] = []
            var trashedIDs: Set<AssetRef.ID> = []
            for asset in targets {
                let outcome = await performAssetTrash(asset)
                results.append(AssetTrashItemResult(id: asset.id, displayName: asset.displayName, outcome: outcome))
                if case .trashed = outcome { trashedIDs.insert(asset.id) }
            }
            if !trashedIDs.isEmpty {
                applyTrashedOut(trashedIDs)
            }
            presentTrashResultIfNeeded(results)
            assetTrashTask = nil
        }
    }

    private func currentGridSelectionIDs() -> [AssetRef.ID] {
        browseVM.isSelecting ? Array(browseVM.selectedIDs) : (browseVM.selectedID.map { [$0] } ?? [])
    }

    // MARK: - Per-item routing

    private func performAssetTrash(_ asset: AssetRef) async -> AssetTrashItemResult.Outcome {
        if isPhotoKitAsset(asset) {
            return .failed("PhotoKit photos have no file on disk Maple can trash — delete them from the Photos app instead.")
        }
        if asset.catalog != nil {
            return await performCloudTrash(asset)
        }
        if let url = asset.primaryURL {
            return await performLocalTrash(asset, url: url)
        }
        if browseVM.currentSource is SMBSource {
            return await performSMBTrash(asset)
        }
        return .failed("This source doesn't support Trash yet.")
    }

    // MARK: - Filesystem

    private func performLocalTrash(_ asset: AssetRef, url: URL) async -> AssetTrashItemResult.Outcome {
        let libraryRoot = asset.scopeParentURL ?? url.deletingLastPathComponent()
        let accessing = libraryRoot.startAccessingSecurityScopedResource()
        defer { if accessing { libraryRoot.stopAccessingSecurityScopedResource() } }
        do {
            _ = try await LocalFileOperations.trash(url, libraryRoot: libraryRoot)
            #if os(macOS)
            return .trashed(destination: .osTrash)
            #else
            return .trashed(destination: .mapleTrash)
            #endif
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    // MARK: - SMB

    private func performSMBTrash(_ asset: AssetRef) async -> AssetTrashItemResult.Outcome {
        guard let source = browseVM.currentSource as? SMBSource, let mapleID = asset.stableID else {
            return .failed("SMB share is not connected")
        }
        let ref = ImageRef(id: mapleID, displayName: asset.displayName, url: nil)
        do {
            _ = try await source.trashAsset(ref)
            return .trashed(destination: .mapleTrash)
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    // MARK: - Cloud

    /// `intent: .trash` (#2749/#2750) — closes the dual-mode staleness
    /// race: a stale grid listing can no longer cause this call to silently
    /// PURGE an already-trashed asset instead of trashing a live one. On
    /// the 409 state-mismatch (which for `.trash` only ever means "this
    /// asset is already trashed" — see `routes/assets/trash.ts`), this
    /// reports the outcome plainly rather than pretending the trash
    /// succeeded or falling through to any purge behavior.
    private func performCloudTrash(_ asset: AssetRef) async -> AssetTrashItemResult.Outcome {
        guard let catalog = asset.catalog, let assetID = asset.stableID else {
            return .failed("This photo hasn't finished indexing on the server yet.")
        }
        let httpClient = makeAuthenticatedHTTPClient(server: catalog.serverID)
        let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: catalog.serverID)
        let remote = RemoteCatalog(http: httpClient, server: effectiveServer)
        do {
            switch try await remote.deleteAsset(assetID: assetID, intent: .trash) {
            case .ok:
                return .trashed(destination: .cloudTrash)
            case .stateMismatch:
                return .failed("This photo is already in the Cloud trash.")
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    // MARK: - Post-batch reconciliation

    /// A trashed asset no longer lives in the folder the grid is showing —
    /// same removal shape as `AppShell+AssetDrop.swift`'s `applyMovedOut`.
    private func applyTrashedOut(_ ids: Set<AssetRef.ID>) {
        browseVM.assets.removeAll { ids.contains($0.id) }
        browseVM.selectedIDs.subtract(ids)
        if let selected = browseVM.selectedID, ids.contains(selected) {
            browseVM.selectedID = nil
        }
        for id in ids {
            sessions.removeValue(forKey: id)
        }
    }

    // MARK: - End-of-batch report

    /// Shown only when something's worth telling the user about: a failure,
    /// or a MIXED-destination batch (e.g. a selection spanning a local
    /// Filesystem asset and an SMB asset lands in two different trashes —
    /// worth naming). A clean, single-destination batch completes silently,
    /// matching `AssetDropResultSheet`'s "all-clean completes silently"
    /// convention — the platform asymmetry itself (macOS → Finder Trash,
    /// everything else → in-app Trash) is surfaced by the context-menu/
    /// Delete-key label wording (`BrowseGrid`'s trash menu item), not by a
    /// sheet on every single delete.
    private func presentTrashResultIfNeeded(_ results: [AssetTrashItemResult]) {
        guard !results.isEmpty else { return }
        let hasFailure = results.contains { if case .failed = $0.outcome { return true }; return false }
        let mixedDestinations = Set(results.compactMap { result -> AssetTrashItemResult.Destination? in
            if case .trashed(let destination) = result.outcome { return destination }
            return nil
        }).count > 1
        guard hasFailure || mixedDestinations else { return }
        assetTrashResults = results
    }

    // MARK: - In-app Trash browser (`.maple/trash` + Cloud only)

    /// Backs `TrashBrowserSheet.onLoad`. Routes by `trashBrowserContext`'s
    /// kind — same three-way split as everywhere else in this file, minus
    /// macOS Filesystem (which never constructs a `.local` context — see
    /// this file's header).
    func loadTrashBrowserRows() async -> [TrashBrowserRow] {
        guard let trashBrowserContext else { return [] }
        switch trashBrowserContext {
        case .local(let libraryRoot, let rootBookmark, _):
            return await withLocalTrashScope(libraryRoot: libraryRoot, rootBookmark: rootBookmark) { root in
                LocalFileOperations.listMapleTrash(libraryRoot: root).map(TrashBrowserRow.init(local:))
            } ?? []
        case .smb(let share):
            guard let source = await connectedTrashSMBSource(for: share) else { return [] }
            return ((try? await source.listTrash()) ?? []).map(TrashBrowserRow.init(local:))
        case .cloud(let server, let libraryFolderID, _):
            let remote = makeCloudTrashClient(server: server)
            let response = try? await remote.listTrash(folderID: libraryFolderID)
            return (response?.items ?? []).map(TrashBrowserRow.init(cloud:))
        }
    }

    /// Backs `TrashBrowserSheet.onRestore`.
    func restoreTrashBrowserRow(_ row: TrashBrowserRow) async -> TrashRowActionOutcome {
        guard let trashBrowserContext else { return .failed("") }
        switch trashBrowserContext {
        case .local(let libraryRoot, let rootBookmark, _):
            let ok = await withLocalTrashScope(libraryRoot: libraryRoot, rootBookmark: rootBookmark) { root in
                (try? await LocalFileOperations.restoreFromMapleTrash(URL(fileURLWithPath: row.id), libraryRoot: root)) != nil
            } ?? false
            return ok ? .succeeded : .failed("")
        case .smb(let share):
            guard let source = await connectedTrashSMBSource(for: share) else { return .failed("") }
            let ok = (try? await source.restoreFromTrash(
                TrashedItem(id: row.id, primaryPath: row.id, sidecarPath: nil,
                           originalRelativePath: row.displayName, trashedDate: row.trashedDate, size: row.size)
            )) != nil
            return ok ? .succeeded : .failed("")
        case .cloud(let server, _, _):
            let remote = makeCloudTrashClient(server: server)
            let ok = (try? await remote.restoreAsset(assetID: row.id, targetRelativePath: nil)) != nil
            return ok ? .succeeded : .failed("")
        }
    }

    /// Backs `TrashBrowserSheet.onPermanentlyDelete`.
    func permanentlyDeleteTrashBrowserRow(_ row: TrashBrowserRow) async -> TrashRowActionOutcome {
        guard let trashBrowserContext else { return .failed("") }
        switch trashBrowserContext {
        case .local(let libraryRoot, let rootBookmark, _):
            let ok = await withLocalTrashScope(libraryRoot: libraryRoot, rootBookmark: rootBookmark) { root in
                let item = TrashedItem(id: row.id, primaryPath: row.id, sidecarPath: nil,
                                       originalRelativePath: row.displayName, trashedDate: row.trashedDate, size: row.size)
                return (try? LocalFileOperations.permanentlyDeleteFromMapleTrash(item, libraryRoot: root)) != nil
            } ?? false
            return ok ? .succeeded : .failed("")
        case .smb(let share):
            guard let source = await connectedTrashSMBSource(for: share) else { return .failed("") }
            let item = TrashedItem(id: row.id, primaryPath: row.id, sidecarPath: nil,
                                   originalRelativePath: row.displayName, trashedDate: row.trashedDate, size: row.size)
            do {
                try await source.permanentlyDelete(item)
                return .succeeded
            } catch {
                return .failed("")
            }
        case .cloud(let server, _, _):
            // `intent: .purge` (#2749/#2750) — the server refuses (409) if
            // this row's asset is no longer actually trashed (e.g. restored
            // elsewhere between listing and this call), rather than
            // silently re-trashing a live photo. That refusal surfaces as
            // `.stale`: the action did NOT proceed, and the row is removed
            // from THIS list (it no longer belongs here) with a reason.
            let remote = makeCloudTrashClient(server: server)
            do {
                switch try await remote.deleteAsset(assetID: row.id, intent: .purge) {
                case .ok:
                    return .succeeded
                case .stateMismatch:
                    return .stale(reason: "\"\(row.displayName)\" was restored elsewhere — it's no longer in the trash.")
                }
            } catch {
                return .failed(error.localizedDescription)
            }
        }
    }

    /// Tears down the SMB trash browser's throwaway connection when the
    /// sheet dismisses.
    func dismissTrashBrowser() {
        trashBrowserContext = nil
        if let source = trashBrowserSMBSource {
            Task { await source.disconnect() }
        }
        trashBrowserSMBSource = nil
    }

    private func makeCloudTrashClient(server: URL) -> RemoteCatalog {
        let httpClient = makeAuthenticatedHTTPClient(server: server)
        let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: server)
        return RemoteCatalog(http: httpClient, server: effectiveServer)
    }

    /// Reuses `trashBrowserSMBSource` across calls within one sheet
    /// presentation; connects once on first use via the share's saved
    /// Keychain credentials.
    private func connectedTrashSMBSource(for share: SMBCredentialStore.SavedShare) async -> SMBSource? {
        if let existing = trashBrowserSMBSource { return existing }
        guard let creds = await SMBCredentialStore.shared.credentials(for: share) else { return nil }
        let source = SMBSource()
        do {
            try await source.connect(credentials: creds)
            trashBrowserSMBSource = source
            return source
        } catch {
            return nil
        }
    }

    /// Claims security scope on `rootBookmark`, runs `body` with the
    /// resolved root, then releases scope — the async-body counterpart of
    /// `AppShell+FolderContextMenu.swift`'s `withLocalFolderScope`, needed
    /// because every Trash-browser caller here is itself `async`.
    private func withLocalTrashScope<T>(
        libraryRoot: URL, rootBookmark: Data, _ body: (URL) async -> T
    ) async -> T? {
        var isStale = false
        #if os(macOS)
        let root = try? URL(resolvingBookmarkData: rootBookmark, options: .withSecurityScope,
                            relativeTo: nil, bookmarkDataIsStale: &isStale)
        #else
        let root = try? URL(resolvingBookmarkData: rootBookmark, options: [],
                            relativeTo: nil, bookmarkDataIsStale: &isStale)
        #endif
        guard let root else { return nil }
        let accessing = root.startAccessingSecurityScopedResource()
        defer { if accessing { root.stopAccessingSecurityScopedResource() } }
        return await body(root)
    }

    // MARK: - 30-day `.maple/trash` auto-purge

    private static let trashSweepDebounceKey = "app.justmaple.aperture.trashSweep.lastRun"
    private static let trashSweepInterval: TimeInterval = 24 * 60 * 60

    /// Debounced to at most once per 24h (a `UserDefaults` timestamp, same
    /// mechanism the PhotoKit orphan sweeper uses per `docs/spec/08-io.md`).
    /// macOS Filesystem sources use the real OS Trash — Finder owns its own
    /// purge policy, so nothing here touches them. iOS/iPadOS sweeps every
    /// saved local folder's `.maple/trash` (cheap: just a bookmark resolve
    /// + directory walk, no network). SMB sweeps only the CURRENTLY
    /// connected share — sweeping every saved share would mean opening a
    /// connection to every saved NAS on every launch, which this ticket's
    /// performance invariants don't allow for a background maintenance
    /// task. Cloud's purge is entirely server-side (`workers/trash-gc.ts`)
    /// — nothing for the Apple client to do.
    ///
    /// The debounce timestamp is stamped AFTER the sweep work completes,
    /// not before (review finding): stamping up front means an iOS
    /// background kill mid-sweep silently skips the entire next 24h window
    /// — a real loss for a purge that's already conservative about what it
    /// touches. Runs as one `Task` (not fire-and-forget) precisely so
    /// there's a completion point to stamp at.
    func sweepExpiredMapleTrashIfDue() {
        let defaults = UserDefaults.standard
        if let last = defaults.object(forKey: Self.trashSweepDebounceKey) as? Date,
           Date().timeIntervalSince(last) < Self.trashSweepInterval {
            return
        }

        let currentSMBSource = browseVM.currentSource as? SMBSource
        // `.detached` (review finding, jules): a plain `Task` here inherits
        // `@MainActor` from `AppShell`, so the bookmark resolution +
        // security-scope claim + directory walk below would all run on the
        // main thread — exactly the per-launch main-thread work this sweep
        // is supposed to stay off of. Nothing in this closure touches
        // `AppShell`'s own UI state (`SMBSource` is its own actor;
        // `UserDefaults` is thread-safe), so there's no MainActor hop
        // needed anywhere in it.
        Task.detached(priority: .utility) {
            #if os(iOS)
            for folder in SavedFolderStore.load() {
                var isStale = false
                guard let root = try? URL(resolvingBookmarkData: folder.bookmark, options: [],
                                          relativeTo: nil, bookmarkDataIsStale: &isStale) else { continue }
                let accessing = root.startAccessingSecurityScopedResource()
                defer { if accessing { root.stopAccessingSecurityScopedResource() } }
                LocalFileOperations.sweepExpiredMapleTrash(libraryRoot: root)
            }
            #endif
            if let currentSMBSource {
                await currentSMBSource.sweepExpiredTrash()
            }
            defaults.set(Date(), forKey: Self.trashSweepDebounceKey)
        }
    }
}
