import CoreImage
import Foundation

extension RenderActor {
  public func seed(
    asset: AssetRef,
    decoded: CIImage,
    rawResolution: CGSize,
    decodedAtModel: AdjustmentModel? = nil
  ) {
    self.decodedImage = decoded
    self.decodedRawResolution = rawResolution
    self.decodedForAssetID = asset.id
    self.decodedSidecarMtime = EditSession.sidecarMtime(for: asset)  // #950 fast-path gate
    self.decodedBakedModel = Self.bakedModel(for: asset)  // #950
    self.decodedAtModel = decodedAtModel
    // Seeded buffers (cached rendered preview / embedded JPEG) are
    // low-resolution display previews, never a full decode — refine
    // must upgrade them (#785).
    self.decodedIsFull = false
    // Seeded buffers carry no Auto/Neutral develop distinction; mark
    // the profile unknown so the first real render re-decodes for RAW
    // Auto rather than reusing an AE-On preview under the Auto cube.
    self.decodedProfile = nil
    // Seeded buffers likewise carry no known auto-exposure state
    // (#1387) — same reasoning as `decodedProfile` above.
    self.decodedAutoExposure = nil
    // Seeded preview buffers carry no slider-frame export (#1781); a
    // stale frame from a previous decode must not describe them.
    self.decodedWbFrame = nil
    // Seeded preview buffers carry no AE-gain export (#1167/#2070); 1.0
    // is the correct no-op gain for a buffer with no explicit export
    // (matches `MapleSceneLinearImageData.aeGain`'s default).
    self.decodedAeGain = 1.0
    // Seeded preview buffers carry no lens-correction export (#2231) —
    // same reasoning as `decodedWbFrame` above; a stale value from a
    // previous asset must not describe this one.
    self.decodedCameraSupport = nil
    self.decodedHasLensCorrections = false
    self.decodedLensCorrectionCaInert = true
    self.decodedLensCorrectionDistortionInert = true
    // #2049: a seed is a cache WRITE — bump identity so a GPU-live
    // session uploaded from the previous buffer knows to re-upload.
    self.decodeGeneration &+= 1
  }

  public func seedIfUnpopulated(
    asset: AssetRef,
    decoded: CIImage,
    rawResolution: CGSize,
    decodedAtModel: AdjustmentModel? = nil
  ) -> Bool {
    if decodedImage != nil && decodedForAssetID == asset.id {
      return false
    }
    self.decodedImage = decoded
    self.decodedRawResolution = rawResolution
    self.decodedForAssetID = asset.id
    self.decodedSidecarMtime = EditSession.sidecarMtime(for: asset)  // #950 fast-path gate
    self.decodedBakedModel = Self.bakedModel(for: asset)  // #950
    self.decodedAtModel = decodedAtModel
    self.decodedIsFull = false
    self.decodedProfile = nil  // #871 — see `seed(...)`
    self.decodedAutoExposure = nil  // #1387 — see `seed(...)`
    self.decodedWbFrame = nil  // #1781 — see `seed(...)`
    self.decodedAeGain = 1.0  // #1167/#2070 — see `seed(...)`
    self.decodedCameraSupport = nil
    self.decodedHasLensCorrections = false  // #2231/#3189 — see `seed(...)`
    self.decodedLensCorrectionCaInert = true
    self.decodedLensCorrectionDistortionInert = true
    self.decodeGeneration &+= 1  // #2049 — see `seed(...)`
    return true
  }
}
