// Complete normalization and publish pixels/metadata before any single-flight join returns.
import CoreImage
import Foundation

extension RenderActor {
  func publishDecodedResult(
    _ decodeResult: (
      CIImage, [Float]?, UInt32, WbSliderFrame?, Float, Float, Float, Bool, Bool, Bool,
      RawCameraSupport?, PipelineRenderer.Quality?
    )?,
    asset: AssetRef, requestedBaked: AdjustmentModel?, wantsFull: Bool,
    decodeProfile: Profile?, decodeAutoExposure: AutoExposureMode?, cancelFlag: CancelFlag,
    normalize: @escaping @Sendable (CIImage, AssetRef) async -> CIImage
  ) async -> CIImage? {
    // Asset identity alone cannot distinguish two profile/quality requests
    // for the same RAW. Only this request's flag owns task/cache publication.
    guard decodeCancelFlag === cancelFlag else { return nil }

    guard
      let (
        decoded, decodeNoiseProfile, decodeISO, decodeWbFrame, decodeAeGain, decodeWhitesAnchorEv, decodeNrSamplingScale,
        decodeHasLensCorrections, decodeLensCorrectionCaInert, decodeLensCorrectionDistortionInert,
        decodeCameraSupport, deliveredQuality
      ) = decodeResult
    else {
      decodeTask = nil
      decodeTaskAssetID = nil
      decodePublicationTask = nil
      decodeCancelFlag = nil
      return nil
    }

    let normalized = await normalize(decoded, asset)
    guard decodeCancelFlag === cancelFlag else { return nil }
    // A sized fast decode must NOT clobber a cache that already COVERS
    // it — a fresh cache at least as large, same asset/profile/baked
    // model. Downgrading resolution silently is the bug (#785); the
    // read-side coverage check in `decodeAndRender` re-evaluates against
    // whatever the CURRENT cache holds, so an overwrite that DOES happen
    // is never served below the size it was decoded at. But letting the
    // write through anyway would defeat #2039's whole point: a fast tick
    // completing after a bigger refine-covering decode would evict the
    // buffer refine was about to reuse, forcing a redundant re-decode on
    // every fast/refine alternation at the same zoom. So the gate keys on
    // COVERAGE (this decode's resolution vs. what's already cached), not
    // on `decodedIsFull` alone — `decodedIsFull` is only ever true for a
    // literal full decode (nothing currently requests one through this
    // path, #2039), so keying solely on it made every sized decode write
    // unconditionally.
    //
    // Profile MUST gate the coverage claim too: a same-or-larger cache
    // for a DIFFERENT profile does not already have this decode's data
    // (#871 — Auto vs Neutral develop different buffers at any size), so
    // a profile mismatch always allows the write. Skipping this check
    // would wedge a profile switch to a smaller target in a permanent
    // loop — the new-profile decode is discarded as "already covered" by
    // the stale old-profile buffer, the read side detects the profile
    // mismatch and re-decodes, and the write gate discards it again.
    // AutoExposure gates the same way (#1387) — same reasoning, same
    // hazard, since `auto_exposure` is also a live-override-owned
    // decode-baked field.
    //
    // An equal-size Preview cannot cover an incoming Full/AMaZE decode.
    // Conversely, a completed Full/AMaZE buffer can cover a later Preview;
    // retain both its pixels and quality so Auto fitting stays consistent.
    //
    // Validate the current baked model against the immutable decode input.
    // A Keep during decode/normalization must discard the old result,
    // rather than labeling its pixels with the newly accepted records.
    // #950 — the in-memory decode cache keys on the baked
    // model, not sidecar mtime: a STRIPPED-field edit (re-applied live
    // per tick) must not invalidate it, only a baked-field edit may.
    // The mtime is captured alongside as a fast-path gate for the
    // per-tick freshness check (see `snapshot`); read it FIRST so a
    // write landing mid-capture can only make a future check do an extra
    // parse, never serve stale.
    let currentMtime = EditSession.sidecarMtime(for: asset)
    let currentBaked: AdjustmentModel?
    do { currentBaked = try Self.validatedBakedModel(for: asset) } catch {
      decodeTask = nil
      decodeTaskAssetID = nil
      decodePublicationTask = nil
      decodeCancelFlag = nil
      return nil
    }
    guard currentBaked == requestedBaked else {
      decodeTask = nil
      decodeTaskAssetID = nil
      decodePublicationTask = nil
      decodeCancelFlag = nil
      return nil
    }
    let newRawResolution = decoded.extent.size
    let sameAssetCached = (decodedForAssetID == asset.id) && (decodedImage != nil)
    let cachedCoversNewDecode = Self.cacheCoversNewDecode(
      sameAsset: sameAssetCached,
      sameProfile: decodedProfile == decodeProfile,
      sameAutoExposure: decodedAutoExposure == decodeAutoExposure,
      sameBakedModel: decodedBakedModel == currentBaked,
      sameQuality: decodedQuality == deliveredQuality
        || (deliveredQuality == .preview && decodedQuality != nil),
      cachedRawResolution: decodedRawResolution,
      newRawResolution: newRawResolution
    )
    let shouldWrite = Self.shouldWriteDecodedCache(
      wantsFull: wantsFull, cachedCoversNewDecode: cachedCoversNewDecode
    )
    if shouldWrite {
      decodedImage = normalized
      decodedRawResolution = newRawResolution
      decodedForAssetID = asset.id
      decodedAtModel = EditSession.parseSidecarModel(for: asset)
      decodedBakedModel = currentBaked
      decodedSidecarMtime = currentMtime
      decodedIsFull = wantsFull
      decodedProfile = decodeProfile  // #871 — buffer is profile-keyed
      decodedAutoExposure = decodeAutoExposure  // #1387 — buffer is autoExposure-keyed too
      decodedQuality = deliveredQuality
      // PR #1709 review fix 4: store noise profile + ISO alongside the
      // decoded buffer so processSceneLinear can forward them to the NR
      // stage without a re-decode. Written only on the same shouldWrite
      // path as the image itself — a fast decode that doesn't clobber a
      // covering cache also doesn't update the noise profile/ISO.
      decodedNoiseProfile = decodeNoiseProfile
      decodedISO = decodeISO
      // #1781: the slider-frame export rides the same write gate as
      // the buffer it describes.
      decodedWbFrame = decodeWbFrame
      // #1167/#2070: the AE-gain export rides the same write gate —
      // `NativeDetailRenderer` needs the gain of the buffer actually
      // on screen, not a stale one from a superseded decode.
      decodedAeGain = decodeAeGain
      decodedWhitesAnchorEv = decodeWhitesAnchorEv
      decodedNrSamplingScale = decodeNrSamplingScale
      // Camera/lens support rides the same write gate (describes this decoded buffer).
      decodedHasLensCorrections = decodeHasLensCorrections
      decodedLensCorrectionCaInert = decodeLensCorrectionCaInert
      decodedLensCorrectionDistortionInert = decodeLensCorrectionDistortionInert
      decodedCameraSupport = decodeCameraSupport
      // #2049: identity bump — any real write means the uploaded GPU
      // buffer (if any) is now potentially stale even at unchanged dims.
      decodeGeneration &+= 1
    }
    decodeTask = nil
    decodeTaskAssetID = nil
    decodePublicationTask = nil
    decodeCancelFlag = nil
    // Pair the returned image with the metadata actually retained by the write gate.
    return shouldWrite ? normalized : decodedImage
  }
}
