// src/apple/MapleFileProvider/WorkingSetEnumerator.swift
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
import MapleCore
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

    init(catalog: RemoteCatalog,
         workingSet: WorkingSet,
         cursorStore: ChangeCursorStore,
         domainID: String,
         listCache: WorkingSetListCache) {
        self.catalog = catalog
        self.workingSet = workingSet
        self.cursorStore = cursorStore
        self.domainID = domainID
        self.listCache = listCache
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
                let items = entries.map { MapleItem(workingSetEntry: $0) }
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

    func enumerateChanges(for observer: NSFileProviderChangeObserver,
                          from anchor: NSFileProviderSyncAnchor) {
        let since = Self.parseAnchor(anchor)
        Task {
            do {
                let page = try await catalog.listChanges(since: since, limit: Self.changesPageLimit)
                var updates: [NSFileProviderItem] = []
                var deletes: [NSFileProviderItemIdentifier] = []
                for ch in page.changes {
                    guard let assetID = ch.assetID else { continue }
                    let ident = NSFileProviderItemIdentifier(
                        FileProviderIdentifier.asset(assetID).rawValue
                    )
                    if ch.kind == .delete {
                        deletes.append(ident)
                        workingSet.remove(identifier: ident.rawValue)
                    } else {
                        // We don't have a per-asset metadata endpoint yet;
                        // hand back a stub whose itemVersion derives from
                        // the cursor so the OS asks `item(for:)` for the
                        // real metadata. A follow-up phase should add
                        // GET /api/assets/:id and skip this round-trip.
                        let stub = MapleItem(stubAssetID: assetID, cursor: ch.cursor)
                        updates.append(stub)
                        // Touch the working set so eviction reflects activity.
                        workingSet.upsert(
                            identifier: ident.rawValue,
                            kind: .recent,
                            lastTouched: ch.at
                        )
                    }
                }
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
                // the next call starts where this one left off.
                let moreComing = page.changes.count >= Self.changesPageLimit
                observer.finishEnumeratingChanges(upTo: newAnchor, moreComing: moreComing)
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

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        let cursor = cursorStore.load(domain: domainID)
        completionHandler(Self.anchor(cursor))
    }

    // MARK: - Helpers

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
actor WorkingSetListCache {
    private let catalog: RemoteCatalog
    private var cached: [AssetListEntry]?

    init(catalog: RemoteCatalog) { self.catalog = catalog }

    func entries() async throws -> [AssetListEntry] {
        if let c = cached { return c }
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
        return merged
    }

    func invalidate() { cached = nil }
}
