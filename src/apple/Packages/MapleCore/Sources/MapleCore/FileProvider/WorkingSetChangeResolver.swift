// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/WorkingSetChangeResolver.swift
//
// Bounded-concurrency change-feed row resolution for
// `WorkingSetEnumerator.enumerateChanges`. Split out of that file to stay
// under the file-size budget (#2311, #2535) — `WorkingSetEnumerator`
// itself owns the `NSFileProviderEnumerator` conformance and calls
// `resolveChanges` as its one entry point into this namespace.

import FileProvider
import Foundation
import OSLog

enum WorkingSetChangeResolver {
    /// Outcome of resolving one change-feed row, tagged with its
    /// position in the original `page.changes` array so results —
    /// completed out of order by the task group in `resolveChanges` —
    /// can be reassembled into the change feed's original order before
    /// `didUpdate`/`didDeleteItems` ever see them.
    private struct IndexedOutcome {
        let index: Int
        let outcome: ChangeOutcome
    }

    private enum ChangeOutcome {
        case skip
        case delete(NSFileProviderItemIdentifier)
        case update(NSFileProviderItem)
        /// The per-asset metadata GET failed because the network itself
        /// was unreachable — see `isNetworkUnreachable`. Kept separate
        /// from the generic transient-failure `.update(stub)` outcome so
        /// `resolveChanges` can detect it and abort the whole batch
        /// instead of handing back a stub for this (and, in a genuine
        /// outage, every other) row.
        case networkUnreachable
    }

    enum ChangesResolution {
        case resolved(updates: [NSFileProviderItem], deletes: [NSFileProviderItemIdentifier])
        case networkUnreachable
    }

    /// Upper bound on simultaneous per-asset metadata GETs
    /// (`RemoteCatalog.getAsset`) while resolving one `enumerateChanges`
    /// batch. `catalog` is a single actor / HTTP client also serving
    /// `item(for:)`, `fetchContents`, and interactive Finder browsing
    /// concurrently, so firing all `changesPageLimit` (500, see
    /// `WorkingSetEnumerator`) requests at once would starve everything
    /// else the extension is doing — and File Provider extensions run
    /// under a hard OS execution-time budget, so 500 SEQUENTIAL
    /// round-trips (the bug this bounds) risks the OS terminating
    /// enumeration mid-batch just as badly. 12 sits between those two
    /// failure modes: a full 500-row batch drops from ~500 sequential
    /// round-trips to ~42 bounded "waves," while leaving headroom for
    /// whatever else is concurrently hitting the catalog.
    private static let maxConcurrentMetadataFetches = 12

    /// Resolves every row in `changes` concurrently, bounded by
    /// `maxConcurrentMetadataFetches` via `BoundedAsyncSemaphore`, then
    /// reassembles the results in original change-feed order.
    ///
    /// `workingSet` mutations happen HERE, in this synchronous pass over
    /// `ordered` — never inside the concurrent per-row resolution
    /// (`resolveChange`, which does not touch `workingSet` at all). A
    /// row's own metadata GET can finish after a LATER row's
    /// synchronous delete already ran, so completion order is not feed
    /// order; mutating in completion order let a delete get silently
    /// overwritten by a slower update for the same asset that the feed
    /// said came first (jules review, PR #2687). Applying mutations
    /// only after `ordered` is re-sorted back into feed index order
    /// keeps a later delete always winning over an earlier update for
    /// the same asset, and — since this loop runs only past the
    /// `hitNetworkOutage` guard below — means a batch aborted for a
    /// network outage applies NO mutations at all, instead of an
    /// arbitrary subset the task group happened to finish first.
    static func resolveChanges(
        _ changes: [AssetChange],
        catalog: RemoteCatalog,
        roots: [LibraryRoot],
        workingSet: WorkingSet,
        log: Logger
    ) async -> ChangesResolution {
        // #2995 — two amplification fixes over the original one-GET-per-row
        // shape, which cost ~502 requests per 500-row page and pinned the
        // iOS extension at ~300 req/s while draining a backlog:
        //
        //   1. Dedupe: the pipeline stages (thumb, xmp, describe, …) each
        //      emit a row for the same asset, so a page usually names far
        //      fewer identities than rows. Only the LAST row per identity
        //      is resolved — the earlier rows describe states the final
        //      one supersedes, so the applied end state is identical.
        //   2. Batch: all surviving asset upserts resolve through ONE
        //      `POST /api/assets/batch-meta` call instead of a GET each.
        //      A server without the route (nil) falls back to the legacy
        //      per-row path so old Self Hosted servers keep working.
        let survivors = Self.dedupedByIdentity(changes)
        let upsertIDs = survivors.compactMap { (_, ch) -> String? in
            guard let id = ch.assetID, ch.kind != .delete else { return nil }
            return id
        }

        var batchMeta: [String: AssetMetadata]? = nil
        if !upsertIDs.isEmpty {
            do {
                if let metas = try await catalog.getAssetsBatch(assetIDs: upsertIDs) {
                    batchMeta = Dictionary(metas.map { ($0.id, $0) },
                                           uniquingKeysWith: { _, last in last })
                } else {
                    log.notice("batch-meta unsupported by server; falling back to per-asset GETs")
                }
            } catch {
                if Self.isNetworkUnreachable(error) {
                    log.notice("network unreachable resolving batch of \(upsertIDs.count) change(s)")
                    return .networkUnreachable
                }
                log.notice("batch-meta failed (\(error.localizedDescription, privacy: .public)); falling back to per-asset GETs")
            }
        }

        let semaphore = BoundedAsyncSemaphore(value: maxConcurrentMetadataFetches)
        let indexed = await withTaskGroup(of: IndexedOutcome.self) { group in
            for (index, ch) in survivors {
                group.addTask {
                    // Asset upserts resolved by the batch response never
                    // touch the network again; everything else (file rows,
                    // deletes, and the no-batch fallback) keeps the
                    // original bounded per-row path.
                    if let batchMeta, let assetID = ch.assetID, ch.kind != .delete {
                        return IndexedOutcome(
                            index: index,
                            outcome: Self.outcomeFromBatch(assetID: assetID,
                                                           meta: batchMeta[assetID],
                                                           roots: roots))
                    }
                    let outcome = await Self.resolveChange(
                        ch, catalog: catalog, roots: roots,
                        semaphore: semaphore, log: log
                    )
                    return IndexedOutcome(index: index, outcome: outcome)
                }
            }
            var results: [IndexedOutcome] = []
            results.reserveCapacity(survivors.count)
            for await result in group {
                results.append(result)
            }
            return results
        }
        let ordered = indexed.sorted { $0.index < $1.index }
        let hitNetworkOutage = ordered.contains {
            if case .networkUnreachable = $0.outcome { return true }
            return false
        }
        guard !hitNetworkOutage else { return .networkUnreachable }

        var updates: [NSFileProviderItem] = []
        var deletes: [NSFileProviderItemIdentifier] = []
        for entry in ordered {
            switch entry.outcome {
            case .skip, .networkUnreachable:
                continue
            case .delete(let ident):
                deletes.append(ident)
                workingSet.remove(identifier: ident.rawValue)
            case .update(let item):
                updates.append(item)
                // Touch the working set so eviction reflects activity.
                // Uses the change-feed row's own timestamp (via
                // `changes[entry.index]`, not wall-clock "now") so
                // `lastTouched` reflects when the server recorded the
                // event, matching the original sequential loop.
                workingSet.upsert(identifier: item.itemIdentifier.rawValue,
                                  kind: .recent,
                                  lastTouched: changes[entry.index].at)
            }
        }
        return .resolved(updates: updates, deletes: deletes)
    }

    /// Collapses a change-feed page to its LAST row per identity,
    /// preserving each surviving row's original feed index (so the
    /// caller's ordered mutation pass keeps feed-order semantics).
    /// Identity is the asset id for indexed rows, `(folderID,
    /// relativePath)` for `FileChild` rows, and per-row-unique for rows
    /// with neither (they resolve to `.skip` individually, as before).
    private static func dedupedByIdentity(_ changes: [AssetChange]) -> [(Int, AssetChange)] {
        var lastIndexByIdentity: [String: Int] = [:]
        for (index, ch) in changes.enumerated() {
            let key: String
            if let assetID = ch.assetID {
                key = "a:\(assetID)"
            } else if let folderID = ch.folderID, let rel = ch.relativePath, !rel.isEmpty {
                key = "f:\(folderID):\(rel)"
            } else {
                key = "row:\(index)"
            }
            lastIndexByIdentity[key] = index
        }
        return lastIndexByIdentity.values.sorted().map { ($0, changes[$0]) }
    }

    /// Maps one asset upsert row's batch-resolution result to an outcome:
    /// present → real item (same construction as the per-row GET path);
    /// absent → the row raced a server-side delete, mirroring `getAsset`'s
    /// nil-on-404.
    private static func outcomeFromBatch(assetID: String,
                                         meta: AssetMetadata?,
                                         roots: [LibraryRoot]) -> ChangeOutcome {
        let ident = NSFileProviderItemIdentifier(
            FileProviderIdentifier.asset(assetID).rawValue
        )
        guard let meta else { return .delete(ident) }
        let parent = WorkingSetEnumerator.resolveParent(folderID: meta.folderID,
                                                        absPath: meta.absPath,
                                                        roots: roots)
        return .update(MapleItem(assetMetadata: meta, parent: parent))
    }

    /// Resolves a single change-feed row. Delete rows resolve
    /// synchronously; create/update rows do the per-asset metadata GET
    /// (`RemoteCatalog.getAsset`), permit-gated by `semaphore`,
    /// reproducing the three outcomes the old sequential loop produced
    /// inline:
    ///   - GET succeeds → real `MapleItem`, real folder parent (resolved
    ///     against the pre-fetched `roots`, never a fresh actor hop).
    ///   - GET 404s     → the change-feed row raced a server-side
    ///     delete; report it as a delete instead of an item whose
    ///     content will 404 forever.
    ///   - GET throws a genuine connectivity error → `.networkUnreachable`
    ///     (see `isNetworkUnreachable`), so the caller can abort the
    ///     whole batch rather than stub every row in the outage.
    ///   - GET throws any other error (bad HTTP status from a server we
    ///     DID reach, decode failure, or `semaphore.acquire()` throwing
    ///     `CancellationError` because the enclosing task was cancelled
    ///     while queued behind the cap) → fall back to the placeholder
    ///     so `itemVersion` still bumps and the OS re-asks via
    ///     `item(for:)`; its parent is never `.workingSet` (see
    ///     `MapleItem`'s stub initializer — that identifier is
    ///     permanently `noSuchItem`).
    ///
    /// A row with no `assetID` (#2535) is a non-indexed `FileChild` —
    /// video, PDF, extensionless, anything `RemoteCatalog.listDir` didn't
    /// index — routed to `resolveFileChange` instead of dropped. Every
    /// `FileChild`-backed file used to be silently discarded here
    /// (`guard let assetID = ch.assetID else { return .skip }`), which is
    /// why those files never live-updated in Finder.
    ///
    /// Deliberately does NOT touch `workingSet` — see `resolveChanges`'s
    /// doc comment for why those mutations are applied by the caller,
    /// serially, in feed order, instead of from here.
    private static func resolveChange(
        _ ch: AssetChange,
        catalog: RemoteCatalog,
        roots: [LibraryRoot],
        semaphore: BoundedAsyncSemaphore,
        log: Logger
    ) async -> ChangeOutcome {
        guard let assetID = ch.assetID else {
            return await Self.resolveFileChange(ch, catalog: catalog, semaphore: semaphore, log: log)
        }
        let ident = NSFileProviderItemIdentifier(
            FileProviderIdentifier.asset(assetID).rawValue
        )
        if ch.kind == .delete {
            return .delete(ident)
        }

        var acquired = false
        defer {
            // Fire-and-forget release — `defer` can't `await`. Mirrors
            // the established `BoundedAsyncSemaphore` release idiom in
            // `CloudTimelineViewModel.loadPage`; the detached Task won't
            // be cancelled by this row's own cancellation.
            if acquired {
                Task.detached { await semaphore.release() }
            }
        }
        do {
            try await semaphore.acquire()
            acquired = true
            guard let meta = try await catalog.getAsset(assetID: assetID) else {
                // Genuine 404: the change-feed row raced a server-side
                // delete. Report it as a delete rather than handing the
                // OS an item whose content will 404 forever.
                return .delete(ident)
            }
            let parent = WorkingSetEnumerator.resolveParent(folderID: meta.folderID,
                                                             absPath: meta.absPath,
                                                             roots: roots)
            return .update(MapleItem(assetMetadata: meta, parent: parent))
        } catch {
            if Self.isNetworkUnreachable(error) {
                log.notice("network unreachable resolving \(assetID, privacy: .public) during enumerateChanges")
                return .networkUnreachable
            }
            log.notice("getAsset failed for \(assetID, privacy: .public) during enumerateChanges, falling back to stub: \(error.localizedDescription, privacy: .public)")
            let stub = MapleItem(stubAssetID: assetID,
                                 cursor: ch.cursor,
                                 folderID: ch.folderID,
                                 relativePath: ch.relativePath)
            return .update(stub)
        }
    }

    /// Resolves a change-feed row for a non-indexed `FileChild` (#2535) —
    /// `ch.assetID` is nil, so identity is `(folderID, relativePath)`
    /// instead of a Mongo id (see `FileProviderIdentifier.file`'s doc
    /// comment). Both must be present and `relativePath` non-empty; either
    /// missing means the server couldn't reconcile the row to a path (see
    /// `AssetChange.relativePath`'s doc comment) and there is no other way
    /// to identify the file — skip rather than guess.
    ///
    /// Mirrors `resolveChange`'s asset branch shape (semaphore-gated stat,
    /// 404 → delete, network failure → `.networkUnreachable`, other error
    /// → stub) but calls `RemoteCatalog.statFile` instead of `getAsset` and
    /// builds the item via `MapleItem`'s existing `file:` initializer.
    private static func resolveFileChange(
        _ ch: AssetChange,
        catalog: RemoteCatalog,
        semaphore: BoundedAsyncSemaphore,
        log: Logger
    ) async -> ChangeOutcome {
        guard let folderID = ch.folderID,
              let relativePath = ch.relativePath, !relativePath.isEmpty else {
            return .skip
        }
        let ident = NSFileProviderItemIdentifier(
            FileProviderIdentifier.file(folderID: folderID, relativePath: relativePath).rawValue
        )
        if ch.kind == .delete {
            return .delete(ident)
        }

        let parentRel = (relativePath as NSString).deletingLastPathComponent
        let parentRaw = FileProviderIdentifier.folder(folderID: folderID, relativePath: parentRel).rawValue
        let parentID = NSFileProviderItemIdentifier(parentRaw)

        var acquired = false
        defer {
            if acquired {
                Task.detached { await semaphore.release() }
            }
        }
        do {
            try await semaphore.acquire()
            acquired = true
            guard let meta = try await catalog.statFile(folderID: folderID, relativePath: relativePath) else {
                // Genuine 404: the change-feed row raced a server-side
                // delete/move. Report it as a delete rather than handing
                // the OS an item whose content will 404 forever.
                return .delete(ident)
            }
            return .update(MapleItem(file: meta, folderID: folderID,
                                     relativePath: relativePath, parentIdentifier: parentID))
        } catch {
            if Self.isNetworkUnreachable(error) {
                log.notice("network unreachable resolving file \(relativePath, privacy: .private) during enumerateChanges")
                return .networkUnreachable
            }
            log.notice("statFile failed for \(relativePath, privacy: .private) during enumerateChanges, falling back to stub: \(error.localizedDescription, privacy: .public)")
            let filename = (relativePath as NSString).lastPathComponent
            let ext = (filename as NSString).pathExtension.lowercased()
            let stub = FileChild(name: filename, path: "", mtime: ch.at, size: 0, ext: ext)
            return .update(MapleItem(file: stub, folderID: folderID,
                                     relativePath: relativePath, parentIdentifier: parentID))
        }
    }

    /// True for `URLError` codes that mean the client couldn't reach the
    /// network/host at all. Deliberately narrower than "any `URLError`":
    /// `RemoteCatalog.check2xx` throws `URLError(.badServerResponse)` for
    /// ANY non-2xx HTTP status, including a one-off 500 for a single
    /// asset on an otherwise healthy connection — that case stays on the
    /// per-item stub-fallback path (see
    /// `testEnumerateChangesFallsBackToStubWithoutWorkingSetParent`),
    /// since the server WAS reached and a retry of just that asset is
    /// reasonable. These codes, by contrast, mean the request never got
    /// a response from anything.
    private static func isNetworkUnreachable(_ error: Error) -> Bool {
        guard let urlError = error as? URLError else { return false }
        switch urlError.code {
        case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
             .cannotFindHost, .dnsLookupFailed, .timedOut, .internationalRoamingOff,
             .callIsActive, .dataNotAllowed:
            return true
        default:
            return false
        }
    }
}
