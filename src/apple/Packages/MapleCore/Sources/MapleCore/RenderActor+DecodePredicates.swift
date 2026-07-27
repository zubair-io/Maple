// RenderActor+DecodePredicates.swift — pure decode-cache decision rules.
//
// Extracted verbatim from `RenderActor+DecodedCache.swift` to keep that file
// inside the 600-line hard budget (`tools/check-file-budget.sh`). These three
// `nonisolated static` predicates touch no actor state — they exist as free
// functions precisely so the cache-reuse and write-gate rules can be unit
// tested without standing up a `RenderActor` (#2039).

import Foundation
import CoreImage

extension RenderActor {
    // MARK: - Refine-sufficiency predicate (pure, testable, #2039)

    /// Whether a cached decode is sufficient for the REFINE phase: either a
    /// genuine full-resolution decode, or a sized decode whose extent already
    /// COVERS the requested `targetSize` (holds every pixel the request
    /// needs, so reuse can never publish below the requested quality — the
    /// #785 invariant, preserved via coverage rather than exact fullness). A
    /// `nil` target (the `renderFull()` export-prep path) has no bound to
    /// check coverage against, so only `isFull` can satisfy it.
    nonisolated static func refineCacheSufficient(
        isFull: Bool, rawResolution: CGSize, targetSize: CGSize?
    ) -> Bool {
        if isFull { return true }
        guard let targetSize else { return false }
        return rawResolution.width >= targetSize.width - 0.5
            && rawResolution.height >= targetSize.height - 0.5
    }

    // MARK: - Write-gate coverage predicate (pure, testable, #2039/#871)

    /// Whether the EXISTING cache already covers what a just-completed
    /// decode would offer — same asset, same profile (#871), same baked
    /// model (#950), and a resolution at least as large as the new decode's.
    /// All four must hold: profile and baked-model mismatches mean the
    /// cached pixels are DIFFERENT content, not merely a smaller version of
    /// the same content, so a mismatch on either always yields `false`
    /// (permit the write) regardless of resolution. Skipping the profile
    /// check here would wedge a profile switch to a smaller target in a
    /// permanent loop: the new-profile decode gets discarded as "already
    /// covered" by the stale old-profile buffer, the read-side profile
    /// check (`decodeAndRender`'s `profileMatches`) detects the mismatch and
    /// re-decodes, and the write gate discards the result again forever.
    nonisolated static func cacheCoversNewDecode(
        sameAsset: Bool,
        sameProfile: Bool,
        sameAutoExposure: Bool = true,
        sameBakedModel: Bool,
        cachedRawResolution: CGSize,
        newRawResolution: CGSize
    ) -> Bool {
        sameAsset && sameProfile && sameAutoExposure && sameBakedModel
            && cachedRawResolution.width >= newRawResolution.width - 0.5
            && cachedRawResolution.height >= newRawResolution.height - 0.5
    }

    // MARK: - Write-gate predicate (pure, testable)

    /// Decide whether a just-completed decode may write the decoded-image
    /// cache. A full decode always wins. A sized (fast) decode writes unless
    /// the cache ALREADY COVERS it — same asset, same profile, same baked
    /// model, and a resolution at least as large as this decode's (#2039)
    /// — in which case writing would only downgrade or needlessly re-store
    /// an equivalent buffer. `cachedCoversNewDecode` is never served past its
    /// own coverage claim: the read-side coverage check in `decodeAndRender`
    /// re-evaluates against whatever IS in the cache, so a write that DOES
    /// go through is always safe to serve at its own size (#785).
    nonisolated static func shouldWriteDecodedCache(
        wantsFull: Bool, cachedCoversNewDecode: Bool
    ) -> Bool {
        wantsFull || !cachedCoversNewDecode
    }
}
