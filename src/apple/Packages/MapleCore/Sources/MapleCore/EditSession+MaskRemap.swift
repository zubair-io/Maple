// EditSession+MaskRemap.swift — the layer stack as a partial-frame render
// buffer must see it (#355).
//
// raw-core evaluates masks in full-frame normalized coordinates, and the
// CPU refine (`decodeAndRender`), the export and every other platform feed
// it the whole frame — the crop is applied AFTER the chain. Two Apple paths
// feed the chain a buffer that is not the whole frame, and both route their
// stack through `remappedLocalAdjustments` first:
//
// - GPU-live crops the decoded buffer before upload (#1617):
//   `MaskAffine.cropToFullFrame(appliedCrop, …)` in `presentViaGpuLive`.
// - Native detail runs the per-tick chain on a 1:1 viewport patch:
//   `MaskAffine.windowToFullFrame(window: decodeRect, …)` in
//   `refineNativeDetail`.
//
// Linear / radial masks remap by parameter rewrite (`MaskRemap`, exact).
// A `.bitmap` layer is re-expressed as a derived raster
// (`MaskRemapRasterCache.resample`) registered with the process-wide
// registry and swapped in by id — a per-affine miss reads the source raster
// from `maskRasterStore` once; every following tick at the same affine is a
// cache hit and allocates nothing beyond the remapped stack itself.

import Foundation

@MainActor
extension EditSession {
  /// `renderModel` with its layer stack re-expressed through `affine` —
  /// the model a partial-frame chain consumes. `renderModel` itself for
  /// the identity map or an empty stack.
  func renderModel(remappedThrough affine: MaskAffine) async -> AdjustmentModel {
    let base = renderModel
    guard !affine.isIdentity, !base.localAdjustments.isEmpty else { return base }
    var out = base
    out.localAdjustments = await remappedLocalAdjustments(base.localAdjustments, through: affine)
    return out
  }

  /// `layers` re-expressed in the coordinate space `affine` maps back to
  /// the full frame. Identity ⇒ `layers` unchanged. A bitmap layer whose
  /// derived raster cannot be produced keeps an unresolved id. This makes
  /// its entire group inert rather than using incorrectly placed coverage.
  func remappedLocalAdjustments(
    _ layers: [LocalAdjustment], through affine: MaskAffine
  ) async -> [LocalAdjustment] {
    guard !affine.isIdentity, !layers.isEmpty else { return layers }
    var out = MaskRemap.remappedGeometry(layers, through: affine)
    for index in out.indices {
      out[index].mask = await out[index].mask.mappingLeavesAsync { mask in
        switch mask {
        case .bitmap(let recipe, let rasterId) where rasterId != 0:
          guard let derived = await self.derivedMaskRasterId(recipe: recipe, affine: affine) else {
            return .bitmap(recipe: recipe, rasterId: 0)
          }
          return .bitmap(recipe: recipe, rasterId: derived)
        case .brush(let dabs, let digest, let rasterId) where rasterId != 0:
          guard let derived = await self.derivedBrushRasterId(dabs: dabs, digest: digest, affine: affine)
          else {
            return .brush(dabs: dabs, digest: digest, rasterId: 0)
          }
          return .brush(dabs: dabs, digest: digest, rasterId: derived)
        default:
          return mask
        }
      }
    }
    return out
  }

  /// The registry id of `recipe`'s raster resampled through `affine` —
  /// from `maskRemapRasters` on a hit, else built, registered and cached.
  private func derivedMaskRasterId(recipe: BitmapRecipe, affine: MaskAffine) async -> UInt32? {
    let source: MaskRasterStore.Raster
    do {
      source = try await sourceMaskRaster(for: recipe)
    } catch {
      editSessionLogger.error(
        "mask raster \(recipe.digest, privacy: .public): derived raster unavailable — \(String(describing: error), privacy: .public)"
      )
      return nil
    }
    return await derivedRasterId(digest: recipe.digest, source: source, affine: affine)
  }

  /// The registry id of a brush stroke's raster resampled through `affine`
  /// — same cache, but the source bytes stamp from the dabs rather than
  /// loading from the raster store.
  private func derivedBrushRasterId(dabs: [BrushDab], digest: String, affine: MaskAffine) async
    -> UInt32?
  {
    guard let source = sourceBrushRaster(dabs: dabs) else {
      editSessionLogger.error(
        "brush raster \(digest, privacy: .public): derived raster unavailable")
      return nil
    }
    return await derivedRasterId(digest: digest, source: source, affine: affine)
  }

  /// Resample `source` through `affine`, register the derived raster and
  /// cache its id — shared by the bitmap and brush paths above.
  private func derivedRasterId(
    digest: String, source: MaskRasterStore.Raster, affine: MaskAffine
  ) async -> UInt32? {
    let key = MaskRemapRasterCache.Key(digest: digest, affine: affine)
    if let hit = maskRemapRasters.id(for: key) { return hit }
    // Detached: the resample is a few hundred thousand bilinear samples
    // over a segmentation-sized raster, and this runs on the MainActor.
    // Only ever on a miss (a crop change, or a settled 1:1 window), but
    // a miss must not stall the canvas.
    let derived = await Task.detached(priority: .userInitiated) {
      MaskRemapRasterCache.resample(source, through: affine)
    }.value
    guard
      let id = MaskRasterRegistry.register(
        digest: MaskRemapRasterCache.derivedDigest(for: key),
        width: derived.width, height: derived.height, bytes: derived.bytes)
    else {
      editSessionLogger.error(
        "mask raster \(digest, privacy: .public): derived registration rejected")
      return nil
    }
    maskRemapRasters.insert(id, for: key)
    // The cache may already hold an id for this key from a racing miss;
    // it kept that one and released `id`, so read back the winner.
    return maskRemapRasters.id(for: key)
  }
}
