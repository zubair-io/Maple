// PhotoKitMergeAdapter.swift
//
// Bridge between CloudTimelineViewModel and PhotoKit. Owns a month-bucket
// cache so timeline page loads can fetch PhotoKit ImageRefs for a (year, month)
// range without re-enumerating the entire library on every page request.
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

    /// Built once per active timeline session (lazy on first call). Keyed by
    /// UTC (year, month). Rebuilt after `invalidate()`.
    private var bucketsByMonth: [BucketKey: [ImageRef]] = [:]
    private var built: Bool = false

    // MARK: - Init

    public init() {}

    // MARK: - API

    /// PhotoKit ImageRefs whose creationDate falls in the given (year, month)
    /// window (UTC). Builds the full month-bucket cache on the first call.
    public func assetsForMonth(year: Int, month: Int) -> [ImageRef] {
        if !built { build() }
        return bucketsByMonth[BucketKey(year: year, month: month)] ?? []
    }

    /// Drop the cache. Call when settings change (different library) or when
    /// the PhotoKit library changes (PhotoKitChangeObserver notification).
    public func invalidate() {
        bucketsByMonth.removeAll()
        built = false
    }

    // MARK: - Private

    private func build() {
        defer { built = true }
        #if canImport(Photos)
        guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized
                || PHPhotoLibrary.authorizationStatus(for: .readWrite) == .limited
        else { return }

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
        bucketsByMonth = buckets
        #endif
    }
}
