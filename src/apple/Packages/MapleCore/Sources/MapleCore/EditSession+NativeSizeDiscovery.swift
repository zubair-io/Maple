// EditSession+NativeSizeDiscovery.swift — native image size discovery +
// decoded-extent → native-canvas normalisation.
//
// Split VERBATIM from EditSession+Hydration.swift (file-size budget, #2041;
// same pattern as the #120 Hydration split itself). Owns how
// `nativeImageSize` gets seeded — the sync URL metadata read on the hot
// paths, and the async bytes-provider read for sourceless assets — and how
// a decoded buffer is normalised onto the native canvas extent before
// publish. The cold-open orchestration that calls these stays in
// EditSession+Hydration.swift.

import Foundation
import CoreImage

@MainActor
extension EditSession {
    // MARK: - Native image size discovery

    /// Synchronous URL-driven seed. Used by `decodedForNativeCanvas` (the
    /// hot render path) and by `ensureRenderStarted`. Sourceless assets
    /// (no `primaryURL`) need the async variant below — they have to pull
    /// bytes through `bytesProvider` first.
    func seedNativeImageSizeFromMetadata(_ url: URL) {
        guard nativeImageSize == .zero,
              let size = ImageMetadataReader.readPixelSize(from: url)?.cgSize,
              size.width > 0,
              size.height > 0
        else { return }
        nativeImageSize = size
    }

    /// Sourceless-aware variant. PhotoKit and Self-Hosted assets surface
    /// bytes through `bytesProvider` without a stable URL — without this
    /// path `nativeImageSize` stays zero and `imageExtent` returns nil, so
    /// the canvas shows the placeholder forever (audit fix A / Ticket 10
    /// item J). Reads bytes through the provider, runs the Data-based
    /// `readPixelSize` (which walks every subimage exactly like the URL
    /// path), and writes the result back on the main actor.
    func seedNativeImageSizeFromMetadataAsync(_ asset: AssetRef) async {
        guard nativeImageSize == .zero else { return }
        if let url = asset.primaryURL {
            seedNativeImageSizeFromMetadata(url)
            return
        }
        guard let provider = asset.bytesProvider else { return }
        guard let data = try? await provider() else { return }
        let hint = asset.hintExtension
        // Re-check identity + native-size after the await — the user may
        // have switched assets while bytes were fetching.
        guard nativeImageSize == .zero, self.asset.id == asset.id else { return }
        guard let size = ImageMetadataReader
            .readPixelSize(from: data, identifierHint: hint)?.cgSize,
              size.width > 0, size.height > 0
        else { return }
        nativeImageSize = size
    }

    // MARK: - Decoded → native canvas normalisation

    func decodedForNativeCanvas(_ decoded: CIImage, asset: AssetRef) -> CIImage {
        let decodedSize = decoded.extent.size
        if nativeImageSize == .zero, let url = asset.primaryURL {
            seedNativeImageSizeFromMetadata(url)
        }
        // Sourceless / bytes-backed assets seed `nativeImageSize` once, at
        // cold-open in `ensureRenderStarted` (#1604) — a single trigger point.
        // Re-kicking the async bytes seed here would race that one and could
        // call `bytesProvider()` (a network fetch) a second time, so it is
        // intentionally not duplicated. The current call returns the unscaled
        // decode; the cold-open seed's `_scheduleRender(.fast)` re-normalises
        // to the real canvas once the native size lands.
        // ONLY metadata is allowed to seed `nativeImageSize`. Earlier
        // versions of this method had a "slack-grow" path that wrote
        // `decodedSize` whenever it was 10% larger than the current
        // native — but the SIZED-FFI buffer's dimensions are
        // VIEWPORT-DERIVED (target ≈ viewport-edge × displayScale, NOT
        // sensor dims). User reported on iPad: 100 MP image → first
        // sized FFI returned 2084×1389 → slack-grow promoted it to
        // "native" → "100%" rendered at 2084 px instead of ~12000.
        // Trusting metadata exclusively means the canvas waits for a
        // real sensor-dim seed before showing pixels at all (better
        // than the wrong scale). When metadata is unavailable for an
        // asset (PhotoKit / Self-Hosted), the canvas waits forever —
        // tracked in audit fix A (sourceless-metadata path).

        guard nativeImageSize.width > 0,
              nativeImageSize.height > 0,
              decodedSize.width > 0,
              decodedSize.height > 0
        else { return decoded }

        let sx = nativeImageSize.width / decodedSize.width
        let sy = nativeImageSize.height / decodedSize.height
        guard sx.isFinite, sy.isFinite, sx > 0, sy > 0 else { return decoded }
        guard abs(sx - 1) > 0.01 || abs(sy - 1) > 0.01 else { return decoded }

        let decodedAspect = decodedSize.width / decodedSize.height
        let nativeAspect = nativeImageSize.width / nativeImageSize.height
        guard abs(decodedAspect - nativeAspect) / nativeAspect < 0.03 else { return decoded }

        editSessionLogger.debug(
            "normalizing decoded extent \(decodedSize.width)x\(decodedSize.height) to native canvas \(self.nativeImageSize.width)x\(self.nativeImageSize.height)"
        )
        let originNormalized = decoded.transformed(by: CGAffineTransform(
            translationX: -decoded.extent.origin.x,
            y: -decoded.extent.origin.y
        ))
        return originNormalized
            .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
            .cropped(to: CGRect(origin: .zero, size: nativeImageSize))
    }
}
