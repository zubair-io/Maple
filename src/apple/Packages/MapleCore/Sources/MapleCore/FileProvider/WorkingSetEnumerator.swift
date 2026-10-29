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
//
// The bounded-concurrency change-feed row resolution `enumerateChanges`
// delegates to lives in `WorkingSetChangeResolver.swift` (split out to
// stay under the file-size budget, #2311/#2535).

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
                // An entry whose library isn't listed is left out rather
                // than shown at the top level (#5503).
                let roots = try await libraryRoots(covering: Set(entries.map(\.folderID)))
                for start in stride(from: 0, to: entries.count, by: Self.enumerationBatchSize) {
                    let batch = entries[start..<min(start + Self.enumerationBatchSize, entries.count)]
                    observer.didEnumerate(batch.compactMap { e -> MapleItem? in
                        Self.resolveParent(folderID: e.folderID, absPath: e.absPath, roots: roots)
                            .map { MapleItem(workingSetEntry: e, parent: $0) }
                    })
                }
                observer.finishEnumerating(upTo: nil)
            } catch {
                log.error("workingSet enumerate failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(enumerationError(error))
            }
        }
    }

    /// Per-call cap on rows pulled from `/api/changes`. When the
    /// returned page hits this size we report `moreComing: true` so the
    /// OS will call `enumerateChanges` again from the new anchor; the
    /// remaining backlog is then drained in a second (and third, …)
    /// round-trip.
    private static let changesPageLimit = FileProviderChangeEnumeration.pageLimit

    /// Items handed to the OS per `didEnumerate` call, so the extension
    /// never holds every working-set item at once (#5456).
    static let enumerationBatchSize = 200

    func enumerateChanges(for observer: NSFileProviderChangeObserver,
                          from anchor: NSFileProviderSyncAnchor) {
        guard let since = Self.parseAnchor(anchor) else {
            observer.finishEnumeratingWithError(
                NSError(domain: NSFileProviderErrorDomain,
                        code: NSFileProviderError.syncAnchorExpired.rawValue))
            return
        }
        Task {
            guard await FileProviderChangeEnumeration.acquire(for: observer) else { return }
            defer { FileProviderChangeEnumeration.release() }
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
                let roots = try await libraryRoots(covering: Set(page.changes.compactMap(\.folderID)))
                let resolution = await WorkingSetChangeResolver.resolveChanges(
                    page.changes, catalog: catalog, roots: roots,
                    workingSet: workingSet, log: log
                )
                switch resolution {
                case .networkUnreachable:
                    // A genuine connectivity failure (not merely a bad
                    // HTTP status from a server we DID reach) hit the
                    // per-asset metadata GET. Handing every row in the
                    // batch its own placeholder stub would paint
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
                case .aborted(let underlying):
                    // Batch-meta got an HTTP error from a reached server
                    // (already mapped into NSFileProviderErrorDomain by
                    // check2xx — auth, 5xx). Fail the call without
                    // advancing the anchor; the OS retries the batch
                    // later instead of the resolver fanning out ~500
                    // per-asset GETs at an unhealthy server.
                    observer.finishEnumeratingWithError(underlying)
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
                // Jump the persisted cursor to the server's current one BEFORE
                // signalling expiry, or the recovery never completes. The OS
                // answers `syncAnchorExpired` by re-enumerating items, which
                // never calls `cursorStore.save`; it then asks for
                // `currentSyncAnchor`, gets the same stale cursor back, and
                // takes another 409 on the next delta call — around and around.
                // `ChangeFeedClient` hit exactly this livelock and fixed it the
                // same way. Saving is monotonic-max, so a `current` behind what
                // we already hold is ignored rather than rewinding us.
                if e.current > 0 {
                    cursorStore.save(e.current, domain: domainID)
                }
                log.notice("stale cursor (server current=\(e.current)); advancing anchor and requesting full re-enumeration")
                observer.finishEnumeratingWithError(
                    NSError(domain: NSFileProviderErrorDomain,
                            code: NSFileProviderError.syncAnchorExpired.rawValue)
                )
            } catch {
                log.error("enumerateChanges failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(enumerationError(error))
            }
        }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        let cursor = cursorStore.load(domain: domainID)
        completionHandler(Self.anchor(cursor))
    }

    // MARK: - Helpers

    /// Loaded once per call; a failure fails the call so the OS retries,
    /// instead of resolving every item against an empty list. The served
    /// list may predate a library added since, so one that misses any of
    /// `folderIDs` is fetched fresh once; an asset whose library is still
    /// absent is skipped and its change consumed, since no folder of
    /// Maple's can show it either. No rootCache means no libraries.
    private func libraryRoots(covering folderIDs: Set<String>) async throws -> [LibraryRoot] {
        guard let rootCache else { return [] }
        let served = try await rootCache.roots()
        guard !folderIDs.subtracting([""]).isSubset(of: Set(served.map(\.id))) else { return served }
        await rootCache.invalidate()
        return try await rootCache.roots()
    }

    /// The folder an asset sits in, or nil when its library is not in
    /// `roots`. Nil is never mapped to `.rootContainer`: the OS keeps that
    /// parent and shows the asset at the top level until it next changes
    /// (#5503). Never `.workingSet` either, which `item(for:)` answers with
    /// `noSuchItem`. An `absPath` outside its library resolves to the
    /// library root.
    static func resolveParent(folderID: String,
                              absPath: String,
                              roots: [LibraryRoot]) -> NSFileProviderItemIdentifier? {
        guard let root = roots.first(where: { $0.id == folderID }) else { return nil }
        let rootWithSlash = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard absPath.hasPrefix(rootWithSlash) else {
            return NSFileProviderItemIdentifier(
                FileProviderIdentifier.folder(folderID: folderID, relativePath: "").rawValue)
        }
        let relative = String(absPath.dropFirst(rootWithSlash.count))
        let parentRelative = (relative as NSString).deletingLastPathComponent
        return NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: folderID, relativePath: parentRelative).rawValue)
    }

    private static func kindFor(_ e: AssetListEntry) -> WorkingSetKind {
        // Priority order matches the eviction ladder in WorkingSetKind.
        // Favourites (rating ≥ 1) and XMP-bearing assets are eviction-
        // immune; recent-only assets are evicted first under pressure.
        if e.rating >= 1 { return .favorite }
        if e.hasXMP { return .xmp }
        return .recent
    }

    /// Prefix of every working-set anchor. A bare-cursor anchor comes from
    /// a build that could parent items at the top level (#5503); refusing
    /// it once makes the OS list the working set again and re-read every
    /// item's parent.
    static let anchorPrefix = "ws2:"

    static func anchor(_ cursor: Int64) -> NSFileProviderSyncAnchor {
        NSFileProviderSyncAnchor(Data((anchorPrefix + String(cursor)).utf8))
    }

    /// Nil when `anchor` predates `anchorPrefix` or cannot be read.
    static func parseAnchor(_ anchor: NSFileProviderSyncAnchor) -> Int64? {
        guard let text = String(data: anchor.rawValue, encoding: .utf8),
              text.hasPrefix(anchorPrefix) else { return nil }
        return Int64(text.dropFirst(anchorPrefix.count))
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
    private let limit: Int

    /// `now` is injectable so tests can advance the clock deterministically
    /// instead of sleeping past a real TTL window. `limit` caps each of the
    /// three queries at the platform's working-set capacity (#5456): on iOS
    /// three 20,000-row responses alone would exceed the extension's 20 MB
    /// limit. A library with more favourites or XMP-bearing photos than
    /// that seeds only `limit` of each; the rest still enumerate through
    /// their folders.
    init(catalog: RemoteCatalog, ttl: TimeInterval = 5 * 60,
         limit: Int = WorkingSet.defaultCapacity,
         now: @escaping () -> Date = Date.init) {
        self.catalog = catalog
        self.ttl = ttl
        self.limit = limit
        self.now = now
    }

    func entries() async throws -> [AssetListEntry] {
        if let c = cached, let cachedAt, now().timeIntervalSince(cachedAt) < ttl {
            return c
        }
        // One query at a time, so only one response body is ever decoding.
        // Later writes win — we want favourite/xmp metadata if the same
        // asset appears in multiple result sets, so merge recent first,
        // then the eviction-immune kinds.
        var byId: [String: AssetListEntry] = [:]
        let thirtyDaysAgo = Date().addingTimeInterval(-30 * 86_400)
        for e in try await catalog.listAssets(capturedAfter: thirtyDaysAgo, limit: limit).assets {
            byId[e.id] = e
        }
        for e in try await catalog.listAssets(ratingGTE: 1, limit: limit).assets { byId[e.id] = e }
        for e in try await catalog.listAssets(hasXMP: true, limit: limit).assets { byId[e.id] = e }
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
