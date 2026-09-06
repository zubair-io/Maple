// EditSession+NativeSizeDiscovery.swift — native image size discovery +
// decoded-extent → native-canvas normalisation. Metadata is read once off
// MainActor; normalization itself only uses the already-published size.

import CoreImage
import Foundation

@MainActor
extension EditSession {
  // MARK: - Native image size discovery

  /// Metadata may parse a RAW container or materialize a File Provider file.
  /// Keep both URL and byte-backed reads off MainActor, and share one task
  /// across repeated layout/open callbacks until the native size is known.
  func seedNativeImageSizeFromMetadataAsync(_ asset: AssetRef) async {
    guard nativeImageSize == .zero, self.asset.id == asset.id else { return }
    let ownsTask = nativeSizeTask == nil
    let task: Task<ImageMetadataReader.PixelSize?, Never>
    if let existing = nativeSizeTask {
      task = existing
    } else {
      let ownedAsset = self.asset
      task = Task.detached(priority: .userInitiated) {
        if let url = ownedAsset.primaryURL {
          let scope = ownedAsset.scopeParentURL ?? url.deletingLastPathComponent()
          let accessing = scope.startAccessingSecurityScopedResource()
          defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
          return autoreleasepool { ImageMetadataReader.readPixelSize(from: url) }
        }
        guard let data = try? await ownedAsset.bytesProvider?() else { return nil }
        guard !Task.isCancelled else { return nil }
        return autoreleasepool {
          ImageMetadataReader.readPixelSize(from: data, identifierHint: ownedAsset.hintExtension)
        }
      }
      nativeSizeTask = task
    }
    let size = await task.value
    if ownsTask, size == nil { nativeSizeTask = nil }
    guard !Task.isCancelled, self.asset.id == asset.id else { return }
    guard nativeImageSize == .zero, let size, size.width > 0, size.height > 0 else { return }
    nativeImageSize = size.cgSize
  }

  // MARK: - Decoded → native canvas normalisation

  func decodedForNativeCanvas(_ decoded: CIImage, asset: AssetRef) -> CIImage {
    let decodedSize = decoded.extent.size
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
    let originNormalized = decoded.transformed(
      by: CGAffineTransform(
        translationX: -decoded.extent.origin.x,
        y: -decoded.extent.origin.y
      ))
    return
      originNormalized
      .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
      .cropped(to: CGRect(origin: .zero, size: nativeImageSize))
  }
}
