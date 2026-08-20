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
                let resolution = await WorkingSetChangeResolver.resolveChanges(
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

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        let cursor = cursorStore.load(domain: domainID)
        completionHandler(Self.anchor(cursor))
    }

    // MARK: - Helpers

    /// Same shape as `FileProviderExtensionCore.resolveAssetParent` but
    /// scoped to the WorkingSet enumeration loop — caller pre-fetches
    /// the roots once and we resolve all entries against the same list.
    /// Also called from `WorkingSetChangeResolver.resolveChange`.
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
