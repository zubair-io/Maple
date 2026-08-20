// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/WorkingSetEnumerator.swift
//
// Backs `.workingSet` (Phase 5b). Phase 1's EmptyEnumerator returned
// nothing; this enumerator seeds the working set from three list
// queries (favourites + xmp-bearing + recent) and applies deltas from
// the change feed on subsequent enumerateChanges calls.
//
// Sync anchor: ASCII bytes of the latest server cursor we've seen.
// When the requested anchor is stale (NSFileProviderError.syncAnchorExpired
// thrown), the OS drops cached delta state and re-enumerates from
// scratch — that's our 409-equivalent on the client side.

import FileProvider
import Foundation
import OSLog

final class WorkingSetEnumerator: NSObject, NSFileProviderEnumerator {
    private let catalog: RemoteCatalog
    private let workingSet: WorkingSet
    private let cursorStore: ChangeCursorStore
    private let domainID: String
    private let listCache: WorkingSetListCache
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider",
                             category: "workingset")
    /// Counts change events applied since the list cache was last
    /// invalidated. The cache is populated lazily by
    /// `WorkingSetListCache.entries()` from three list queries; the
    /// change feed keeps the working-set table fresh, but the list
    /// cache itself goes stale as soon as new assets land. Reseed
    /// after a small batch so the next cold-start `enumerateItems`
    /// sees recent additions without waiting for the extension to
    /// restart.
    private static let listCacheInvalidationThreshold = 50
    private var eventsSinceListCacheReseed = 0

    private let rootCache: LibraryRootCache?

    init(catalog: RemoteCatalog,
         workingSet: WorkingSet,
         cursorStore: ChangeCursorStore,
         domainID: String,
         listCache: WorkingSetListCache,
         rootCache: LibraryRootCache? = nil) {
        self.catalog = catalog
        self.workingSet = workingSet
        self.cursorStore = cursorStore
        self.domainID = domainID
        self.listCache = listCache
        self.rootCache = rootCache
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver,
                        startingAt page: NSFileProviderPage) {
        Task {
            do {
                let entries = try await listCache.entries()
                let now = Date()
                for e in entries {
                    let kind = Self.kindFor(e)
                    workingSet.upsert(
                        identifier: FileProviderIdentifier.asset(e.id).rawValue,
                        kind: kind,
                        lastTouched: now
                    )
                }
                // Resolve each entry's real folder parent so working-set
                // items don't appear under a "Working Set" container in
                // Finder. The OS still uses the working set for indexing
                // and search; with real parents, items show up only in
                // their owning folder.
                let roots = (try? await rootCache?.roots()) ?? []
                let items = entries.map { e -> MapleItem in
                    let parent = Self.resolveParent(folderID: e.folderID,
                                                     absPath: e.absPath,
                                                     roots: roots)
                    return MapleItem(workingSetEntry: e, parent: parent)
                }
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
            } catch {
                log.error("workingSet enumerate failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    /// Per-call cap on rows pulled from `/api/changes`. When the
    /// returned page hits this size we report `moreComing: true` so the
    /// OS will call `enumerateChanges` again from the new anchor; the
    /// remaining backlog is then drained in a second (and third, …)
    /// round-trip.
    private static let changesPageLimit = 500

    /// Upper bound on simultaneous per-asset metadata GETs
    /// (`RemoteCatalog.getAsset`) while resolving one `enumerateChanges`
    /// batch. `catalog` is a single actor / HTTP client also serving
    /// `item(for:)`, `fetchContents`, and interactive Finder browsing
    /// concurrently, so firing all `changesPageLimit` (500) requests at
    /// once would starve everything else the extension is doing — and
    /// File Provider extensions run under a hard OS execution-time
    /// budget, so 500 SEQUENTIAL round-trips (the bug this bounds) risks
    /// the OS terminating enumeration mid-batch just as badly. 12 sits
    /// between those two failure modes: a full 500-row batch drops from
    /// ~500 sequential round-trips to ~42 bounded "waves," while leaving
    /// headroom for whatever else is concurrently hitting the catalog.
    private static let maxConcurrentMetadataFetches = 12

    func enumerateChanges(for observer: NSFileProviderChangeObserver,
                          from anchor: NSFileProviderSyncAnchor) {
        let since = Self.parseAnchor(anchor)
        Task {
            do {
                let page = try await catalog.listChanges(since: since, limit: Self.changesPageLimit)
                // Prefetch the library roots ONCE per call. Each row
                // used to resolve its parent via
                // `FileProviderExtensionCore.resolveAssetParent(meta:
                // rootCache:)`, which re-enters `LibraryRootCache
                // .roots()` — an actor hop plus revalidation — on every
                // single item. `enumerateItems` already prefetches once
                // and resolves against the cached list via
                // `Self.resolveParent(folderID:absPath:roots:)`; mirror
                // that here (Copilot review, PR #2687).
                let roots = (try? await rootCache?.roots()) ?? []
                let resolution = await Self.resolveChanges(
                    page.changes, catalog: catalog, roots: roots,
                    workingSet: workingSet, log: log
                )
                switch resolution {
                case .networkUnreachable:
                    // A genuine connectivity failure (not merely a bad
                    // HTTP status from a server we DID reach) hit the
                    // per-asset metadata GET. Handing every row in the
                    // batch its own stub — same hardcoded filename,
                    // same `.rootContainer` parent — would paint
                    // Finder with a pile of colliding "(stub)" entries
                    // for the duration of the outage (jules WARN, PR
                    // #2687). Fail the whole call instead: the anchor
                    // is never advanced (no `finishEnumeratingChanges`
                    // below), so the OS retries this exact batch once
                    // connectivity returns.
                    log.notice("network unreachable resolving \(page.changes.count) change(s); asking the OS to retry rather than stubbing")
                    observer.finishEnumeratingWithError(
                        NSError(domain: NSFileProviderErrorDomain,
                                code: NSFileProviderError.serverUnreachable.rawValue)
                    )
                case .resolved(let updates, let deletes):
                    observer.didUpdate(updates)
                    observer.didDeleteItems(withIdentifiers: deletes)
                    let newAnchor = page.nextCursor.map { Self.anchor($0) } ?? anchor
                    if let next = page.nextCursor {
                        cursorStore.save(next, domain: domainID)
                    }
                    // Bump the list-cache invalidation counter and reseed
                    // once we've absorbed enough changes. We keep the
                    // counter cheap (in-memory, lost on extension recycle —
                    // that's fine, recycle is itself a reseed trigger).
                    eventsSinceListCacheReseed += page.changes.count
                    if eventsSinceListCacheReseed >= Self.listCacheInvalidationThreshold {
                        eventsSinceListCacheReseed = 0
                        await listCache.invalidate()
                    }
                    // If we hit the page cap there's almost certainly more
                    // backlog beyond it. Tell the OS so it loops back with
                    // the new anchor; the cursor we just persisted ensures
                    // the next call starts where this one left off. Gate on
                    // the cursor too: a full page without one leaves the
                    // anchor where it was, and claiming more is coming would
                    // send the OS back with the same anchor indefinitely.
                    let moreComing = page.nextCursor != nil
                        && page.changes.count >= Self.changesPageLimit
                    observer.finishEnumeratingChanges(upTo: newAnchor, moreComing: moreComing)
                }
            } catch let e as StaleCursorError {
                log.notice("stale cursor (server current=\(e.current)); requesting full re-enumeration")
                observer.finishEnumeratingWithError(
                    NSError(domain: NSFileProviderErrorDomain,
                            code: NSFileProviderError.syncAnchorExpired.rawValue)
                )
            } catch {
                log.error("enumerateChanges failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    // MARK: - Bounded-concurrency change resolution

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

    private enum ChangesResolution {
        case resolved(updates: [NSFileProviderItem], deletes: [NSFileProviderItemIdentifier])
        case networkUnreachable
    }

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
    private static func resolveChanges(
        _ changes: [AssetChange],
        catalog: RemoteCatalog,
        roots: [LibraryRoot],
        workingSet: WorkingSet,
        log: Logger
    ) async -> ChangesResolution {
        let semaphore = BoundedAsyncSemaphore(value: maxConcurrentMetadataFetches)
        let indexed = await withTaskGroup(of: IndexedOutcome.self) { group in
            for (index, ch) in changes.enumerated() {
                group.addTask {
                    let outcome = await Self.resolveChange(
                        ch, catalog: catalog, roots: roots,
                        semaphore: semaphore, log: log
                    )
                    return IndexedOutcome(index: index, outcome: outcome)
                }
            }
            var results: [IndexedOutcome] = []
            results.reserveCapacity(changes.count)
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
            let parent = Self.resolveParent(folderID: meta.folderID,
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

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        let cursor = cursorStore.load(domain: domainID)
        completionHandler(Self.anchor(cursor))
    }

    // MARK: - Helpers

    /// Same shape as `FileProviderExtensionCore.resolveAssetParent` but
    /// scoped to the WorkingSet enumeration loop — caller pre-fetches
    /// the roots once and we resolve all entries against the same list.
    ///
    /// Fallbacks mirror the extension-core helper: never `.workingSet`
    /// (the OS now treats that container as `noSuchItem`, which aborts
    /// materialization). folderID-in-roots-but-prefix-mismatch routes
    /// to the library root; folderID-not-in-roots routes to
    /// `.rootContainer`.
    static func resolveParent(folderID: String,
                              absPath: String,
                              roots: [LibraryRoot]) -> NSFileProviderItemIdentifier {
        guard let root = roots.first(where: { $0.id == folderID }) else {
            return .rootContainer
        }
        let rootWithSlash = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard absPath.hasPrefix(rootWithSlash) else {
            let rootIdent = FileProviderIdentifier.folder(folderID: folderID,
                                                           relativePath: "")
            return NSFileProviderItemIdentifier(rootIdent.rawValue)
        }
        let relative = String(absPath.dropFirst(rootWithSlash.count))
        let parentRelative = (relative as NSString).deletingLastPathComponent
        let parentID = FileProviderIdentifier.folder(folderID: folderID,
                                                       relativePath: parentRelative)
        return NSFileProviderItemIdentifier(parentID.rawValue)
    }

    private static func kindFor(_ e: AssetListEntry) -> WorkingSetKind {
        // Priority order matches the eviction ladder in WorkingSetKind.
        // Favourites (rating ≥ 1) and XMP-bearing assets are eviction-
        // immune; recent-only assets are evicted first under pressure.
        if e.rating >= 1 { return .favorite }
        if e.hasXMP { return .xmp }
        return .recent
    }

    private static func anchor(_ cursor: Int64) -> NSFileProviderSyncAnchor {
        NSFileProviderSyncAnchor(String(cursor).data(using: .utf8)!)
    }

    private static func parseAnchor(_ anchor: NSFileProviderSyncAnchor) -> Int64 {
        guard let s = String(data: anchor.rawValue, encoding: .utf8),
              let v = Int64(s) else { return 0 }
        return v
    }
}

/// Caches the three list queries (favourites + xmp + recent) for the
/// extension's lifetime. The change feed is the keep-fresh path; this
/// cache exists so repeated `.workingSet` enumerations don't refetch
/// from scratch on every call.
///
/// Two invalidation paths keep the cache from serving stale data
/// indefinitely:
///   - Event-count gated: `WorkingSetEnumerator` calls `invalidate()`
///     after absorbing `listCacheInvalidationThreshold` change-feed
///     events.
///   - Time-based fallback (#2545): a long-lived extension process
///     that stays under the event threshold — plausible, especially
///     combined with non-image file changes never incrementing that
///     counter — would otherwise serve a stale list forever, since the
///     event path is the ONLY thing that ever called `invalidate()`.
///     `entries()` now self-expires past `ttl` regardless of whether
///     anything ever called `invalidate()`.
public actor WorkingSetListCache {
    private let catalog: RemoteCatalog
    private var cached: [AssetListEntry]?
    private var cachedAt: Date?
    private let ttl: TimeInterval
    private let now: () -> Date

    /// `now` is injectable so tests can advance the clock deterministically
    /// instead of sleeping past a real TTL window.
    init(catalog: RemoteCatalog, ttl: TimeInterval = 5 * 60, now: @escaping () -> Date = Date.init) {
        self.catalog = catalog
        self.ttl = ttl
        self.now = now
    }

    func entries() async throws -> [AssetListEntry] {
        if let c = cached, let cachedAt, now().timeIntervalSince(cachedAt) < ttl {
            return c
        }
        // Pull all three filters and merge by id. Cap each query at 20k
        // (server-side ceiling) — the working set itself is capped at
        // 20k, so we never need more across the union.
        async let favs = catalog.listAssets(ratingGTE: 1, limit: 20_000)
        async let xmps = catalog.listAssets(hasXMP: true, limit: 20_000)
        let thirtyDaysAgo = Date().addingTimeInterval(-30 * 86_400)
        async let recents = catalog.listAssets(capturedAfter: thirtyDaysAgo, limit: 20_000)
        let (a, b, c) = try await (favs.assets, xmps.assets, recents.assets)
        var byId: [String: AssetListEntry] = [:]
        // Later writes win — we want favourite/xmp metadata if the same
        // asset appears in multiple result sets, so order the merge to
        // put recent first, then the eviction-immune kinds.
        for e in c { byId[e.id] = e }
        for e in a + b { byId[e.id] = e }
        let merged = Array(byId.values)
        cached = merged
        cachedAt = now()
        return merged
    }

    func invalidate() {
        cached = nil
        cachedAt = nil
    }
}
