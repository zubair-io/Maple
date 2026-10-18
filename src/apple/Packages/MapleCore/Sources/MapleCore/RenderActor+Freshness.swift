// Decoded-cache freshness: the per-tick `snapshot` check and the baked-model
// key it compares, including the live-model key (#4715) and the export reuse
// rule that must match it. Split from RenderActor+DecodedCache.swift for the
// file-size budget (#2311); the cache state stays declared on RenderActor.

import CoreImage
import Foundation

extension RenderActor {
  /// `liveModel` (#4715): freshness compares the cached baked model to the
  /// session's live model — no disk read, no debounce, and the only
  /// possible key for a remote asset. Without it the sidecar-keyed #950
  /// path below applies.
  public func snapshot(forAsset asset: AssetRef, liveModel: AdjustmentModel? = nil)
    -> DecodedSnapshot
  {
    // #950: unchanged mtime skips the XMP parse. Autosaves of live-only
    // fields keep the baked model valid; accept their observed mtime so
    // later ticks return to this fast path instead of parsing indefinitely.
    // Capture before parsing: a concurrent write must remain detectable on
    // the next tick, never be accepted without comparing its baked model.
    let assetMatches = (decodedForAssetID == asset.id)
    let currentMtime = assetMatches && liveModel == nil ? EditSession.sidecarMtime(for: asset) : nil
    let isFresh: Bool
    if !assetMatches {
      isFresh = false
    } else if let liveModel {
      isFresh = (Self.bakedModel(fromLive: liveModel) == decodedBakedModel)
    } else if decodedSidecarURL == asset.sidecarURL,
      let mt = decodedSidecarMtime, currentMtime == mt
    {
      // File untouched since decode → baked model unchanged.
      isFresh = true
    } else {
      isFresh = (Self.bakedModel(for: asset) == decodedBakedModel)
      if isFresh {
        decodedSidecarMtime = currentMtime
        decodedSidecarURL = asset.sidecarURL
      }
    }
    return DecodedSnapshot(
      image: decodedImage,
      decodedAtModel: decodedAtModel,
      rawResolution: decodedRawResolution,
      isFresh: isFresh,
      isFull: decodedIsFull,
      profile: decodedProfile,
      autoExposure: decodedAutoExposure,
      noiseProfile: decodedNoiseProfile,
      iso: decodedISO,
      wbFrame: decodedWbFrame,
      aeGain: decodedAeGain,
      whitesAnchorEv: decodedWhitesAnchorEv, nrSamplingScale: decodedNrSamplingScale,
      decodeGeneration: decodeGeneration,
      hasLensCorrections: decodedHasLensCorrections,
      lensCorrectionCaInert: decodedLensCorrectionCaInert,
      lensCorrectionDistortionInert: decodedLensCorrectionDistortionInert,
      cameraSupport: assetMatches ? decodedCameraSupport : nil
    )
  }

  // MARK: - Baked-model freshness key (#950)

  /// Cache the model with live GPU stages stripped. An absent sidecar uses
  /// the same semantic defaults as decode, so its first GPU-only save keeps
  /// the decoded buffer (#4266). Baked changes still invalidate by value.
  /// Profile and autoExposure are normalized out because their live overrides
  /// have dedicated cache keys; an autosave must not force a second decode.
  nonisolated static let defaultBakedModel =
    RawCoreBridge.stripAppleGPUStages(AdjustmentModel.default)

  nonisolated static func bakedModel(for asset: AssetRef) -> AdjustmentModel {
    guard EditSession.sidecarMtime(for: asset) != nil else { return defaultBakedModel }
    return bakedModel(fromLive: EditSession.parseSidecarModel(for: asset))
  }

  enum DecodeXMPSource: Equatable {
    case use(URL?)
    case fail
  }

  /// Which XMP the RAW decode bakes (#4715). With a live model the cache is
  /// keyed on that model, so a failed temp-XMP write must fail the decode:
  /// falling back to the disk sidecar would store disk-state pixels under the
  /// live key and report them fresh until some later invalidation.
  nonisolated static func decodeXMPSource(
    hasLiveModel: Bool, liveXMP: URL?, diskSidecar: URL?
  ) -> DecodeXMPSource {
    guard hasLiveModel else { return .use(diskSidecar) }
    return liveXMP.map { .use($0) } ?? .fail
  }

  /// Whether a cached decode can serve an export of `live` (#4715). Uses the
  /// same normalised key the interactive cache stores, so a crop or
  /// perspective edit (presentation stages) does not force a second decode.
  /// Profile and auto exposure are compared by the caller on their own keys.
  nonisolated static func exportCanReuse(cachedBakedModel: AdjustmentModel?, live: AdjustmentModel)
    -> Bool
  {
    let liveBaked = bakedModel(fromLive: live)
    return cachedBakedModel == liveBaked
      || (cachedBakedModel == nil && liveBaked == defaultBakedModel)
  }

  /// The same key, taken from a model already in memory (#4715). Crop and
  /// perspective are presentation stages (raw-core's `prefix_policy!`
  /// lists them so; Apple applies both on the developed image), never
  /// decode-baked, so they are normalised out of the key too.
  nonisolated static func bakedModel(fromLive model: AdjustmentModel) -> AdjustmentModel {
    var m = RawCoreBridge.stripAppleGPUStages(model)
    m.profile = AdjustmentModel().profile  // #871 owns profile freshness
    m.autoExposure = AdjustmentModel().autoExposure  // #1387 owns autoExposure freshness
    m.crop = AdjustmentModel().crop
    m.perspective = AdjustmentModel().perspective
    return m
  }
}
