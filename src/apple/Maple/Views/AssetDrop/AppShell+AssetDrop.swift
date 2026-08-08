// AppShell+AssetDrop.swift — drag assets onto the source tree to move or
// copy (#2646).
//
// UI + wiring only, per the ticket's scope note: every actual file-op
// lives in the already-merged `MapleCore` engines
// (`LocalFileOperations.relocate`, `SMBSource.relocateAsset` →
// `SMBFileOperations.relocate`) or the API
// (`RemoteCatalog.relocateAsset` → `POST /api/assets/:id/relocate`,
// #2629). This file owns:
//   • routing a drop by the DRAGGED asset's source kind, rejecting a
//     destination whose kind doesn't match (Filesystem/SMB/Cloud only —
//     PhotoKit is neither a drag source nor a drop target)
//   • the ask-flow for a collision: probe with a "detect, touch nothing"
//     policy (`.fail` locally/SMB, the API's `"skip"` for Cloud), and on
//     collision suspend via `withCheckedContinuation` until the user
//     answers the `AssetDropCollisionSheet` — one prompt per colliding
//     asset, sequential, matching the design doc's "someone's watching"
//     rationale for asking instead of auto-suffixing
//   • per-item outcome bookkeeping and the end-of-batch report (shown
//     only when something was skipped or failed — an all-clean batch
//     completes silently, matching Finder)
//   • post-move reconciliation: a successfully MOVED asset is no longer
//     inside the folder the grid is showing, so it's removed from
//     `browseVM.assets`/selection/`sessions` in place (no rescan). A
//     COPY leaves the original untouched — nothing to reconcile.
//
// Entry points: `performAssetDrop(ids:destination:mode:)` is called both
// from a `.dropDestination` action (the drag) and from a source-tree row's
// "Move/Copy Selected Here" context-menu item (the keyboard/VoiceOver
// equivalent — see `LibrarySidebar.swift`/`CloudFolderTreeRow.swift`).

import SwiftUI
import MapleCore

@MainActor
extension AppShell {

    // MARK: - Sidebar entry point (drag AND the "Move/Copy Selected Here"
    // keyboard/menu equivalent share this one call site)

    /// `ids == nil` means "use the current grid selection" — the
    /// accessibility fallback: a source-tree row's "Move/Copy Selected
    /// Here" context-menu item (reachable by keyboard and VoiceOver, since
    /// dragging is neither) calls this with `nil` rather than needing the
    /// row itself to know what's selected. `ids` non-nil is the literal
    /// drag payload from `.dropDestination`.
    func handleAssetDrop(ids: Set<AssetRef.ID>?, destination: AssetDropDestination, copy: Bool) {
        let resolved = ids.map(Array.init) ?? currentGridSelectionIDs()
        performAssetDrop(ids: resolved, destination: destination, mode: copy ? .copy : .move)
    }

    private func currentGridSelectionIDs() -> [AssetRef.ID] {
        browseVM.isSelecting ? Array(browseVM.selectedIDs) : (browseVM.selectedID.map { [$0] } ?? [])
    }

    // MARK: - Entry point

    /// Move or copy `ids` (a drag payload, or the current grid selection
    /// from a "Move/Copy Selected Here" menu item) to `destination`.
    /// Ignored while a previous drop is still running — sequential drops
    /// only, so two overlapping batches can't interleave collision prompts.
    func performAssetDrop(ids: [AssetRef.ID], destination: AssetDropDestination, mode: RelocateMode) {
        guard assetDropTask == nil else { return }
        let dragged = ids.compactMap { id in browseVM.assets.first(where: { $0.id == id }) }
        guard !dragged.isEmpty else { return }
        assetDropTask = Task { @MainActor in
            var results: [AssetDropItemResult] = []
            var movedOutIDs: Set<AssetRef.ID> = []
            for asset in dragged {
                let outcome = await performAssetDropItem(asset, destination: destination, mode: mode)
                results.append(AssetDropItemResult(id: asset.id, displayName: asset.displayName, outcome: outcome))
                if mode == .move, outcome == .moved {
                    movedOutIDs.insert(asset.id)
                }
            }
            if !movedOutIDs.isEmpty {
                applyMovedOut(movedOutIDs)
            }
            // A folder row that's already expanded may now have a new
            // child (or one fewer, for a same-tree local move) — bump the
            // same generation counter New Folder/Rename/Trash already use
            // so it re-enumerates without a manual collapse/re-expand.
            if !movedOutIDs.isEmpty || results.contains(where: { $0.outcome == .copied }) {
                folderRefreshGeneration += 1
            }
            presentDropResultIfNeeded(results)
            assetDropTask = nil
        }
    }

    // MARK: - Per-item routing

    /// Routes by the DRAGGED asset's own source kind — the same
    /// catalog-then-primaryURL-then-SMB order `AppShell+AssetRename.swift`'s
    /// `performRename` already uses — and rejects a destination whose kind
    /// doesn't match rather than attempting a cross-source byte transfer
    /// (out of scope: the design doc's routing table names three ENGINES,
    /// not a general file-copy-between-any-two-sources capability).
    private func performAssetDropItem(
        _ asset: AssetRef, destination: AssetDropDestination, mode: RelocateMode
    ) async -> AssetDropItemResult.Outcome {
        if isPhotoKitAsset(asset) {
            return .failed(
                "PhotoKit photos have no file on disk Maple can move — organize them from the Photos app instead.")
        }
        if asset.catalog != nil {
            guard case .cloud = destination else {
                return .failed("This photo is on a Cloud server — it can only be dropped onto a Cloud folder.")
            }
            return await performCloudDrop(asset, destination: destination, mode: mode)
        }
        if let url = asset.primaryURL {
            guard case .local = destination else {
                return .failed("This photo is on the local filesystem — it can only be dropped onto a local folder.")
            }
            return await performLocalDrop(asset, url: url, destination: destination, mode: mode)
        }
        if browseVM.currentSource is SMBSource {
            guard case .smb = destination else {
                return .failed("This photo is on an SMB share — it can only be dropped onto that share.")
            }
            return await performSMBDrop(asset, destination: destination, mode: mode)
        }
        return .failed("This source doesn't support move or copy yet.")
    }

    // MARK: - Filesystem

    private func performLocalDrop(
        _ asset: AssetRef, url: URL, destination: AssetDropDestination, mode: RelocateMode
    ) async -> AssetDropItemResult.Outcome {
        guard case .local(let folderURL, let rootBookmark) = destination else {
            return .failed("Invalid local destination")
        }
        var isStale = false
        #if os(macOS)
        let destRoot = try? URL(resolvingBookmarkData: rootBookmark, options: .withSecurityScope,
                                relativeTo: nil, bookmarkDataIsStale: &isStale)
        #else
        let destRoot = try? URL(resolvingBookmarkData: rootBookmark, options: [],
                                relativeTo: nil, bookmarkDataIsStale: &isStale)
        #endif
        guard let destRoot else {
            return .failed("The destination folder's saved bookmark could not be resolved")
        }
        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        let accessingSource = scope.startAccessingSecurityScopedResource()
        defer { if accessingSource { scope.stopAccessingSecurityScopedResource() } }
        let accessingDest = destRoot.startAccessingSecurityScopedResource()
        defer { if accessingDest { destRoot.stopAccessingSecurityScopedResource() } }

        do {
            return try await runLocalRelocate(url: url, folderURL: folderURL, mode: mode, collision: .fail)
        } catch FileOperationError.destinationExists {
            return await resolveLocalCollision(url: url, folderURL: folderURL, mode: mode, displayName: asset.displayName)
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    private func resolveLocalCollision(
        url: URL, folderURL: URL, mode: RelocateMode, displayName: String
    ) async -> AssetDropItemResult.Outcome {
        let choice = await requestCollisionChoice(displayName: displayName)
        guard choice != .skip else { return .skipped(reason: "collision") }
        do {
            return try await runLocalRelocate(
                url: url, folderURL: folderURL, mode: mode,
                collision: choice == .replace ? .replace : .autoSuffix)
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    private func runLocalRelocate(
        url: URL, folderURL: URL, mode: RelocateMode, collision: CollisionPolicy
    ) async throws -> AssetDropItemResult.Outcome {
        _ = try await LocalFileOperations.relocate(url, to: folderURL, mode: mode, collision: collision)
        return mode == .move ? .moved : .copied
    }

    // MARK: - SMB

    /// SMB has no subfolder tree yet (#2697), so the only reachable
    /// destination is the connected share's root ("/") — enforced by
    /// `AssetDropDestination.smb` carrying only a `SavedShare`, no path.
    private func performSMBDrop(
        _ asset: AssetRef, destination: AssetDropDestination, mode: RelocateMode
    ) async -> AssetDropItemResult.Outcome {
        guard case .smb(let share) = destination else { return .failed("Invalid SMB destination") }
        guard case .smbShare(let currentShare) = librarySelection, currentShare == share else {
            return .failed("Dragging between different SMB shares isn't supported yet.")
        }
        guard let source = browseVM.currentSource as? SMBSource, let mapleID = asset.stableID else {
            return .failed("SMB share is not connected")
        }
        let ref = ImageRef(id: mapleID, displayName: asset.displayName, url: nil)
        do {
            return try await runSMBRelocate(source: source, ref: ref, mode: mode, collision: .fail)
        } catch FileOperationError.destinationExists {
            let choice = await requestCollisionChoice(displayName: asset.displayName)
            guard choice != .skip else { return .skipped(reason: "collision") }
            do {
                return try await runSMBRelocate(
                    source: source, ref: ref, mode: mode,
                    collision: choice == .replace ? .replace : .autoSuffix)
            } catch {
                return .failed(error.localizedDescription)
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    private func runSMBRelocate(
        source: SMBSource, ref: ImageRef, mode: RelocateMode, collision: CollisionPolicy
    ) async throws -> AssetDropItemResult.Outcome {
        _ = try await source.relocateAsset(ref, to: "/", mode: mode, collision: collision)
        return mode == .move ? .moved : .copied
    }

    // MARK: - Cloud

    private func performCloudDrop(
        _ asset: AssetRef, destination: AssetDropDestination, mode: RelocateMode
    ) async -> AssetDropItemResult.Outcome {
        guard case .cloud(let server, let libraryFolderID, let libraryRootPath, let absPath) = destination else {
            return .failed("Invalid Cloud destination")
        }
        guard let catalog = asset.catalog, let assetID = asset.stableID else {
            return .failed("This photo hasn't finished indexing on the server yet.")
        }
        guard catalog.serverID == server else {
            return .failed("Dragging between different Cloud servers isn't supported yet.")
        }
        // #2725: see `CloudDropEligibility`'s doc comment — the relocate
        // endpoint can't express a cross-library move, so it must be
        // refused here rather than silently misplacing the file inside the
        // asset's OWN library. Message matches the web sibling's
        // `drag-move.service.ts` `dropDisabledReason` wording so the two
        // products explain the same restriction identically.
        guard CloudDropEligibility.isSameLibrary(
            assetLibraryFolderID: catalog.folderID, destinationLibraryFolderID: libraryFolderID
        ) else {
            return .failed("Can't move between different libraries")
        }
        guard let destRel = cloudRelativePath(absPath, under: libraryRootPath) else {
            return .failed("\(absPath) is not under this library's root.")
        }
        let httpClient = makeAuthenticatedHTTPClient(server: catalog.serverID)
        let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: catalog.serverID)
        let remote = RemoteCatalog(http: httpClient, server: effectiveServer)
        return await runCloudRelocate(
            remote: remote, assetID: assetID, mode: mode, destRel: destRel, displayName: asset.displayName)
    }

    private func runCloudRelocate(
        remote: RemoteCatalog, assetID: String, mode: RelocateMode, destRel: String, displayName: String
    ) async -> AssetDropItemResult.Outcome {
        do {
            let result = try await remote.relocateAsset(
                assetID: assetID, mode: mode, collision: .fail, destinationPath: destRel)
            switch result {
            case .ok:
                return mode == .move ? .moved : .copied
            case .skipped:
                let choice = await requestCollisionChoice(displayName: displayName)
                guard choice != .skip else { return .skipped(reason: "collision") }
                let retry = try await remote.relocateAsset(
                    assetID: assetID, mode: mode,
                    collision: choice == .replace ? .replace : .autoSuffix, destinationPath: destRel)
                return cloudOutcome(for: retry, mode: mode)
            case .invalid(let message):
                return .failed(message)
            case .notFound:
                return .failed("This photo no longer exists on the server")
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    private func cloudOutcome(for result: RelocateAssetResult, mode: RelocateMode) -> AssetDropItemResult.Outcome {
        switch result {
        case .ok: return mode == .move ? .moved : .copied
        case .skipped(let reason): return .skipped(reason: reason)
        case .invalid(let message): return .failed(message)
        case .notFound: return .failed("This photo no longer exists on the server")
        }
    }

    // MARK: - Collision ask-flow

    /// Suspends the routing loop for ONE asset until
    /// `AssetDropCollisionSheet` resolves `assetDropCollisionPrompt` — via
    /// a button tap OR the sheet's implicit dismissal (swipe/Escape), both
    /// funneled through the SAME `AssetDropCollisionResolver` so the
    /// continuation resumes exactly once either way (review follow-up —
    /// see `AssetDropCollisionResolver`'s doc comment for why the naive
    /// button-only version could hang every subsequent drop for the rest
    /// of the session). `assetDropCollisionResolver` is set alongside the
    /// prompt specifically so `AppShell`'s `.sheet(onDismiss:)` can reach
    /// it after `assetDropCollisionPrompt` itself may already be nil.
    /// Sequential by construction (the loop `await`s this before moving to
    /// the next asset) — exactly one prompt on screen at a time.
    private func requestCollisionChoice(displayName: String) async -> AssetDropCollisionChoice {
        await withCheckedContinuation { continuation in
            let resolver = AssetDropCollisionResolver(continuation: continuation)
            assetDropCollisionResolver = resolver
            assetDropCollisionPrompt = AssetDropCollisionPrompt(displayName: displayName, resolver: resolver)
        }
    }

    // MARK: - Post-batch reconciliation

    /// A successfully MOVED asset no longer lives inside the folder the
    /// grid is currently showing (it was dropped onto a DIFFERENT
    /// source-tree node), so — unlike rename's in-place patch
    /// (`AppShell+AssetRename.swift`'s `applyRenamed`, same folder, new
    /// name) — reconciliation here is removal: drop it from
    /// `browseVM.assets`, selection, and any live `EditSession`. A COPY
    /// leaves the original in its current folder untouched; nothing to
    /// reconcile for it.
    private func applyMovedOut(_ ids: Set<AssetRef.ID>) {
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

    /// Shown only when the batch has something worth telling the user
    /// about — a clean all-moved/all-copied batch completes silently.
    private func presentDropResultIfNeeded(_ results: [AssetDropItemResult]) {
        let noteworthy = results.contains { result in
            switch result.outcome {
            case .moved, .copied: return false
            case .skipped, .failed: return true
            }
        }
        guard noteworthy else { return }
        assetDropResults = results
    }
}
