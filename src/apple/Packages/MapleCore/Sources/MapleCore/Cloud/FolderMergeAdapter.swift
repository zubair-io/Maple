// FolderMergeAdapter.swift
//
// #2274 (unified Timeline Phase 2, deferred half of #2270) — bridges saved
// local Folders into the all-sources Timeline merge. The Folders sibling of
// `PhotoKitMergeAdapter`, same `assetsForMonth`/`localBuckets`/`warmUp`
// shape so `AllSourcesTimelineViewModel` can treat both symmetrically.
//
// Unlike PhotoKit — one library, walked via a PHAsset enumeration that's
// genuinely expensive on a 100k-photo library, hence that adapter's own
// on-disk month-bucket cache — there are up to `SavedFolderStore.capacity`
// (10) independent local folders, each already backed by its own
// `FilesystemSource` with a persistent per-folder cache
// (`LibraryIndex`/`.maple/index.json`, #2656). `FilesystemSource.images()`
// is a directory listing plus a JSON read, not a heavy walk, and its
// `captureDate` now comes from that SAME `LibraryIndex` EXIF cache (#2274's
// other half, `FilesystemSource.images()`) — so this adapter deliberately
// has NO disk-cache layer of its own; re-deriving one here would duplicate
// caching `FilesystemSource` already owns.
//
// `warmUp()` opens every saved folder's `FilesystemSource` and KEEPS each
// ONE ALIVE for the adapter's own lifetime (mirroring how `AppShell` keeps
// `PhotoKitMergeAdapter` alive alongside the Timeline VM) — each source
// holds its own security-scope claim, which detached thumb/render tasks
// triggered from the merged timeline still need after `warmUp()` returns.

import Foundation

@MainActor
public final class FolderMergeAdapter {

    // MARK: - Types

    public struct BucketKey: Hashable, Sendable {
        public let year: Int
        public let month: Int
        public init(year: Int, month: Int) {
            self.year = year; self.month = month
        }
    }

    // MARK: - State

    private var bucketsByMonth: [BucketKey: [ImageRef]] = [:]

    /// One opened `FilesystemSource` per saved folder that resolved
    /// successfully, kept alive for this adapter's lifetime — see the file
    /// header for why. A folder whose bookmark has gone stale (revoked
    /// permission, moved volume) is silently skipped, same as the sidebar's
    /// own handling of a dead bookmark: the Timeline shows every folder
    /// that COULD be opened rather than failing outright over one that
    /// can't.
    private var sources: [FilesystemSource] = []

    /// True after a successful `warmUp()` has produced fresh data this
    /// session — mirrors `PhotoKitMergeAdapter.hasFreshData`.
    public private(set) var hasFreshData: Bool = false

    /// Coalesces concurrent `warmUp()` calls: only one rebuild runs at a time.
    private var warmTask: Task<Void, Never>?

    /// Multi-observer hook fired after `warmUp()` completes — same pattern
    /// as `PhotoKitMergeAdapter.addOnWarmedUp`, so `AllSourcesTimelineViewModel`
    /// re-merges buckets that were loaded before folder data was ready.
    public typealias WarmUpObserverToken = UUID

    @discardableResult
    public func addOnWarmedUp(_ handler: @escaping () -> Void) -> WarmUpObserverToken {
        let token = UUID()
        warmUpObservers[token] = handler
        return token
    }

    public func removeOnWarmedUp(_ token: WarmUpObserverToken) {
        warmUpObservers.removeValue(forKey: token)
    }

    private var warmUpObservers: [WarmUpObserverToken: () -> Void] = [:]

    /// `SavedFolderStore.load(from:)`'s own injectable-`UserDefaults`
    /// pattern, threaded one level up — lets tests seed an isolated
    /// `UserDefaults(suiteName:)` with fake saved folders instead of
    /// touching the real `.standard` list. Production call sites never
    /// pass this; it defaults to `.standard`.
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    // MARK: - API

    /// Local-folder `ImageRef`s whose `captureDate` falls in the given
    /// (year, month) window (UTC) — an asset with no known `captureDate`
    /// yet (its `LibraryIndex` EXIF cache hasn't warmed) buckets under
    /// "now" instead, same fallback `PhotoKitMergeAdapter.buildFromPhotoKit`
    /// uses for a PHAsset with no `creationDate`, so it still appears
    /// somewhere rather than silently vanishing from every month section.
    /// Synchronous — returns whatever's currently cached (empty before the
    /// first `warmUp()`).
    public func assetsForMonth(year: Int, month: Int) -> [ImageRef] {
        bucketsByMonth[BucketKey(year: year, month: month)] ?? []
    }

    /// Every month currently cached, with its combined asset count SUMMED
    /// across every saved folder — folders are mutually disjoint on-disk
    /// locations (never the same underlying file), so summing is the
    /// correct combinator here, unlike `AllSourcesTimelineViewModel`'s
    /// PhotoKit-vs-cloud fold (which uses `max` specifically because THOSE
    /// two populations can genuinely overlap via sync).
    public func localBuckets() -> [(key: BucketKey, count: Int)] {
        bucketsByMonth.map { (key: $0.key, count: $0.value.count) }
    }

    /// Refresh from every saved folder. Idempotent and coalesced —
    /// concurrent callers share the same in-flight Task.
    public func warmUp() async {
        if let existing = warmTask {
            await existing.value
            return
        }
        let t = Task { await self.rebuild() }
        warmTask = t
        await t.value
        // Identity-checked, not an unconditional nil (Jules review, PR
        // #3187): `invalidate()` can run while this `await` is suspended,
        // clearing `warmTask` and letting a NEW `warmUp()` call install its
        // own task in its place. An unconditional `warmTask = nil` here
        // would then clobber that new task's reference once THIS call
        // resumes, breaking coalescing for whoever is awaiting it next.
        // Only clear the slot if it's still holding the task this call
        // itself created.
        if warmTask == t {
            warmTask = nil
        }
    }

    /// Drop the cache and release every opened folder's security scope.
    /// Call when the saved-folders list changes in a way that should force
    /// a clean re-open (mirrors `PhotoKitMergeAdapter.invalidate`).
    ///
    /// Cancels and clears any in-flight `warmUp()` first (Copilot review, PR
    /// #3187): without this, a `rebuild()` already running when
    /// `invalidate()` is called would still be holding `warmTask`, finish
    /// later, and swap fresh `newSources`/`buckets` back in — re-firing
    /// observers — after the caller believed the adapter had been reset.
    /// `rebuild()`'s own `Task.isCancelled` guard (below) is what actually
    /// makes the cancellation stick; this just requests it and severs the
    /// adapter's reference so a future `warmUp()` doesn't await the
    /// cancelled task instead of starting a fresh one.
    ///
    /// Closes from a snapshot taken before `sources` is cleared, not the
    /// live array (Copilot review, PR #3187) — `close()` is async, so
    /// closing `sources` in place while iterating it would race a
    /// concurrent `rebuild()` that starts repopulating the same array.
    public func invalidate() {
        warmTask?.cancel()
        warmTask = nil
        bucketsByMonth.removeAll()
        let closingSources = sources
        sources.removeAll()
        hasFreshData = false
        for source in closingSources {
            Task { await source.close() }
        }
    }

    // MARK: - Private

    private func rebuild() async {
        let saved = SavedFolderStore.load(from: defaults)
        var newSources: [FilesystemSource] = []
        newSources.reserveCapacity(saved.count)
        var buckets: [BucketKey: [ImageRef]] = [:]

        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        // Captured ONCE for this whole rebuild, not re-read per ref
        // (Copilot review, PR #3187): re-calling `Date()` inside the loop
        // let two refs with no cached captureDate land in DIFFERENT month
        // buckets whenever a rebuild's wall-clock time happened to straddle
        // a month boundary while scanning — a real possibility across many
        // folders/files, not just a theoretical race. Every no-date ref in
        // this rebuild now falls back to the SAME instant.
        let fallbackNow = Date()

        for folder in saved {
            // Cancellation check per folder (Copilot review, PR #3187):
            // `invalidate()` may have cancelled this task between folders,
            // and there's no reason to keep opening security-scoped sources
            // — each one just has to be closed again below — for a rebuild
            // whose result is about to be discarded.
            if Task.isCancelled { break }

            let source = FilesystemSource()
            do {
                try await source.restore(fromBookmarkData: folder.bookmark)
            } catch {
                // Stale/revoked bookmark — skip this folder, keep going with
                // the rest. Matches the sidebar's own silent-skip behavior
                // for a folder it can no longer reach.
                continue
            }
            newSources.append(source)

            guard let refs = try? await source.images() else { continue }
            for ref in refs {
                let date = ref.captureDate ?? fallbackNow
                let comps = cal.dateComponents([.year, .month], from: date)
                guard let y = comps.year, let m = comps.month else { continue }
                buckets[BucketKey(year: y, month: m), default: []].append(ref)
            }
        }

        // Cancellation guard (Copilot review, PR #3187): `invalidate()` may
        // have run while the loop above was still awaiting — without this
        // check, the swap below would still apply `newSources`/`buckets`
        // and mark `hasFreshData` true, silently undoing the invalidation
        // and re-firing observers after the caller thought the adapter was
        // reset. Every source opened by THIS rebuild is closed here rather
        // than left for `invalidate()`'s snapshot, which only knew about
        // the sources that existed before this rebuild started.
        guard !Task.isCancelled else {
            for opened in newSources { await opened.close() }
            return
        }

        // Swap state SYNCHRONOUSLY, with no `await` in between (Jules
        // review, PR #3187) — the previous shape closed the
        // previously-opened sources (an `await`ing loop) BEFORE the swap,
        // leaving a second suspension window after the cancellation guard
        // above where `invalidate()` could still run and get silently
        // overwritten once this resumed. Old sources are captured into a
        // local snapshot and closed AFTER the swap instead, so nothing
        // async stands between "cancellation was checked" and "state is
        // applied".
        let oldSources = sources
        sources = newSources
        bucketsByMonth = buckets
        hasFreshData = true

        for handler in warmUpObservers.values {
            handler()
        }

        for old in oldSources { await old.close() }
    }
}
