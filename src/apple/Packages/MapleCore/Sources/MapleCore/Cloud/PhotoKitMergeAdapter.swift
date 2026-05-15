// PhotoKitMergeAdapter.swift
//
// Bridge between CloudTimelineViewModel and PhotoKit. Owns a month-bucket
// cache so timeline page loads can fetch PhotoKit ImageRefs for a (year, month)
// range without re-enumerating the entire library on every page request.
//
// Concurrency model:
//   - The class is `@MainActor`-isolated because cache reads happen from
//     the VM's MainActor context and we want synchronous lookups there.
//   - The actual PhotoKit walk (PHAsset.fetchAssets + enumerateObjects) is
//     heavy — for a 100k-photo library it takes several seconds — so it
//     runs on a detached Task at userInitiated priority. Doing this on
//     MainActor was Copilot's PR #53 catch.
//   - Results are persisted to JSON under Application Support so a re-launch
//     can render the merged timeline INSTANTLY off the disk cache, without
//     waiting for PHAsset enumeration. The disk cache is loaded
//     synchronously in `init` (fast JSON parse, ~100ms even for 100k entries)
//     and refreshed by `warmUp()` in the background.
//
// Lives in MapleCore (alongside CloudTimelineViewModel) so the VM can depend
// on it without pulling in MapleApp. PhotoKit usage is guarded by
// `#if canImport(Photos)` for SPM testability on platforms without the
// framework — on those platforms every method is a no-op.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §12.

import Foundation
#if canImport(Photos)
import Photos
#endif

@MainActor
public final class PhotoKitMergeAdapter {

    // MARK: - Types

    public struct BucketKey: Hashable, Sendable {
        public let year: Int
        public let month: Int
        public init(year: Int, month: Int) {
            self.year = year; self.month = month
        }
    }

    // MARK: - State

    /// Month → asset refs. Populated synchronously in `init` from the on-disk
    /// JSON cache when present, then refreshed by `warmUp()` in the background.
    private var bucketsByMonth: [BucketKey: [ImageRef]] = [:]

    /// True after a successful `warmUp()` has produced fresh data this
    /// session. False on init (even when disk cache loaded — disk data
    /// is fast to read but may be stale). Callers can use this to decide
    /// whether to re-merge after warm-up.
    public private(set) var hasFreshData: Bool = false

    /// Coalesces concurrent `warmUp()` calls: only one rebuild runs at a time.
    private var warmTask: Task<Void, Never>?

    /// Disk cache location. `nil` disables persistence (used in tests).
    private let diskCacheURL: URL?

    /// Fired when `warmUp()` completes successfully. CloudTimelineViewModel
    /// wires this to re-merge buckets that were loaded before the cache was
    /// fresh, so the user doesn't have to scroll to see updated cells.
    ///
    /// Called on MainActor (the property setter runs there).
    public var onWarmedUp: (() -> Void)?

    // MARK: - Init

    public init(diskCacheURL: URL? = PhotoKitMergeAdapter.defaultDiskCacheURL()) {
        self.diskCacheURL = diskCacheURL
        loadFromDiskIfAvailable()
    }

    /// Default cache location: `~/Library/Application Support/Maple/photokit-month-buckets.json`.
    /// Returns `nil` when Application Support isn't resolvable (rare —
    /// sandboxed apps always have one). On that path the adapter still
    /// works, just without disk persistence.
    ///
    /// `nonisolated` so the default-parameter expression on `init` can call
    /// it from any actor context.
    nonisolated public static func defaultDiskCacheURL() -> URL? {
        guard let appSupport = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: false) else { return nil }
        return appSupport
            .appendingPathComponent("Maple", isDirectory: true)
            .appendingPathComponent("photokit-month-buckets.json")
    }

    // MARK: - API

    /// PhotoKit ImageRefs whose creationDate falls in the given (year, month)
    /// window (UTC). Synchronous — returns whatever's currently cached (which
    /// may be empty on first-ever launch before `warmUp()` has finished).
    /// Never enumerates PhotoKit inline; that's `warmUp()`'s job.
    public func assetsForMonth(year: Int, month: Int) -> [ImageRef] {
        bucketsByMonth[BucketKey(year: year, month: month)] ?? []
    }

    /// Refresh the cache from PhotoKit. Idempotent and coalesced — concurrent
    /// callers share the same in-flight Task. PHAsset enumeration runs on a
    /// detached Task so it never blocks the UI. After this returns, the
    /// in-memory cache and the on-disk JSON are both up to date and
    /// `hasFreshData` is true.
    public func warmUp() async {
        if let existing = warmTask {
            await existing.value
            return
        }
        let t = Task { await self.rebuild() }
        warmTask = t
        await t.value
        warmTask = nil
    }

    /// Drop the cache. Call when settings change (different library) or when
    /// the PhotoKit library changes (PhotoKitChangeObserver notification).
    /// Removes the on-disk JSON too — the next `warmUp()` rebuilds from scratch.
    public func invalidate() {
        bucketsByMonth.removeAll()
        hasFreshData = false
        if let url = diskCacheURL {
            try? FileManager.default.removeItem(at: url)
        }
    }

    // MARK: - Private — rebuild + persist

    private func rebuild() async {
        // PHAsset enumeration off main. The detached Task inherits no actor
        // isolation, so it runs on a background executor.
        let buckets = await Task.detached(priority: .userInitiated) {
            PhotoKitMergeAdapter.buildFromPhotoKit()
        }.value

        // Back on MainActor here (resumed after detached Task completed).
        bucketsByMonth = buckets
        hasFreshData = true
        persistAsync(buckets)
        onWarmedUp?()
    }

    private func loadFromDiskIfAvailable() {
        guard let url = diskCacheURL,
              let data = try? Data(contentsOf: url),
              let buckets = try? Self.decodeBuckets(data) else { return }
        bucketsByMonth = buckets
        // hasFreshData stays false — disk data may be stale, callers should
        // still invoke warmUp() and react to onWarmedUp.
    }

    private func persistAsync(_ buckets: [BucketKey: [ImageRef]]) {
        guard let url = diskCacheURL else { return }
        // Encode + atomic write off main — JSON-encoding 100k entries is
        // hundreds of milliseconds, not main-thread material.
        Task.detached(priority: .utility) {
            guard let data = try? PhotoKitMergeAdapter.encodeBuckets(buckets) else { return }
            try? FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    /// PhotoKit enumeration, extracted as a nonisolated static so the detached
    /// Task can call it without crossing an actor boundary mid-walk. Reads
    /// only PHAsset fields (thread-safe per Apple docs) and produces a
    /// Sendable dictionary.
    nonisolated private static func buildFromPhotoKit() -> [BucketKey: [ImageRef]] {
        #if canImport(Photos)
        guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized
                || PHPhotoLibrary.authorizationStatus(for: .readWrite) == .limited
        else { return [:] }

        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let result = PHAsset.fetchAssets(with: .image, options: options)

        var buckets: [BucketKey: [ImageRef]] = [:]
        buckets.reserveCapacity(48) // two years of months is a typical session

        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!

        result.enumerateObjects { phAsset, _, _ in
            let date = phAsset.creationDate ?? Date()
            let comps = cal.dateComponents([.year, .month], from: date)
            guard let y = comps.year, let m = comps.month else { return }
            let key = BucketKey(year: y, month: m)
            let ref = ImageRef(
                id: phAsset.localIdentifier,
                displayName: phAsset.localIdentifier,
                url: nil,
                captureDate: phAsset.creationDate)
            buckets[key, default: []].append(ref)
        }
        return buckets
        #else
        return [:]
        #endif
    }

    // MARK: - Codable wire format
    //
    // JSON dictionaries require String keys, but BucketKey is a struct.
    // Flatten to `[PersistedBucket]` for on-disk shape; decode back into
    // the dict on read.

    /// `nonisolated` so synthesized Codable conformance (which requires
    /// nonisolated init(from:) / encode(to:)) is satisfiable on a type
    /// nested inside a `@MainActor` class.
    nonisolated private struct PersistedBucket: Codable, Sendable {
        let year: Int
        let month: Int
        let refs: [ImageRef]
    }

    nonisolated private static func encodeBuckets(_ buckets: [BucketKey: [ImageRef]]) throws -> Data {
        let persisted = buckets.map {
            PersistedBucket(year: $0.key.year, month: $0.key.month, refs: $0.value)
        }
        return try JSONEncoder().encode(persisted)
    }

    nonisolated private static func decodeBuckets(_ data: Data) throws -> [BucketKey: [ImageRef]] {
        let persisted = try JSONDecoder().decode([PersistedBucket].self, from: data)
        var out: [BucketKey: [ImageRef]] = [:]
        out.reserveCapacity(persisted.count)
        for b in persisted {
            out[BucketKey(year: b.year, month: b.month)] = b.refs
        }
        return out
    }
}
