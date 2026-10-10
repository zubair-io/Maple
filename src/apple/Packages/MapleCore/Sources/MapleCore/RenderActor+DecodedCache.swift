// Per-session decoded-image cache and single-flight RAW decode. Target size,
// profile, auto exposure, baked edits and decode quality form the in-flight identity.
// Cache state is declared on RenderActor; this extension owns its lifecycle.

import CoreImage
import Foundation

extension RenderActor {
  // MARK: - Single-flight decode (slice 2)

  /// Single-flight decode. `target` drives the downsample (#785):
  ///   • `nil`  — full-resolution decode. No production caller passes
  ///              this today (see the #1637/#2143 note on the sized
  ///              branch below) — kept for a hypothetical future
  ///              nil-target caller.
  ///   • sized  — downsampled decode bounded to `target`. RAW routes
  ///              through the sized scene-linear FFI (`maxLongEdge`);
  ///              non-RAW routes through the ImageIO thumbnail decode.
  ///              The full-res bitmap is never allocated just because a
  ///              caller's target happens to approach native (#785).
  ///
  /// `quality` (#2143) is the axis that now actually distinguishes fast
  /// from refine for RAW — see `ImageEditPipeline.refineDecodeQuality`.
  /// It joins `target`'s fullness and `profile` in the in-flight-task
  /// identity so an escalated caller never silently downgrades onto a
  /// lower-quality in-flight task. It is ignored (pinned to `.preview`)
  /// for non-RAW, whose ImageIO decode has no quality axis.
  ///
  /// A `nil`-target caller never joins an in-flight sized task — that
  /// would hand back a low-res buffer. The cache's `decodedIsFull` flag is
  /// set so `snapshot(forAsset:)` can tell the refine pass whether the
  /// cached decode is sufficient.
  func sharedDecode(
    asset: AssetRef,
    target: CGSize? = nil,
    profile: Profile = .auto,
    autoExposure: AutoExposureMode = .on,
    quality: PipelineRenderer.Quality = .preview,
    normalize: @escaping @Sendable (CIImage, AssetRef) async -> CIImage
  ) async -> CIImage? {
    // Videos are selectable for metadata editing (#1638) but have no still
    // frame to decode. No-op the decode rather than feeding container bytes
    // to libraw (RAW path) or CGImageSource (non-RAW path) — both would fail
    // or produce garbage. `AssetRef.isRaw` already returns false for video;
    // this is the single chokepoint all open/render dispatch funnels
    // through, so guarding here covers every entry point.
    //
    // Same treatment for stub images (eip/braw/afphoto/ai) and audio
    // (mp3/wav/m4a/aac, #1835) — metadata-only, no pixels to decode.
    if asset.isVideo || asset.isStub || asset.isAudio {
      return nil
    }
    let wantsFull = (target == nil)
    // #871: the decode buffer is profile-dependent for RAW (Auto
    // develops auto_exposure Off; Neutral keeps it On). Pass the live
    // profile into the scene-linear decode as an override so its
    // AE-Off-when-Auto decision tracks the user's current selection,
    // and make it part of the decode-cache + in-flight-task identity so
    // a profile toggle re-decodes instead of serving the wrong buffer.
    // Non-RAW has no Auto Profile cube, so no override / no keying.
    let decodeProfile: Profile? = asset.isRaw ? profile : nil
    // #1387: the decode buffer is also auto_exposure-dependent for RAW
    // — `auto_exposure` is itself a decode-baked field, and
    // `EditorState.applyAuto` can flip it on the live model (Neutral
    // profile) without waiting for the debounced sidecar write. Same
    // treatment as `decodeProfile` immediately above.
    let decodeAutoExposure: AutoExposureMode? = asset.isRaw ? autoExposure : nil
    // Sized RAW requests use the requested demosaic; a nil target uses
    // the full-resolution preference. Capture that actual quality for both
    // task identity and the completed buffer. Non-RAW has no quality axis.
    // #2143: `quality` only steers the RAW demosaic — the non-RAW branch
    // below routes through `decodeSceneLinearNonRaw`, which takes no
    // quality at all. Pin non-RAW to `.preview` so an escalated caller
    // can't make quality a spurious identity axis there (a re-decode +
    // cancel for a bit-identical buffer). Same reasoning, and the same
    // shape, as `decodeProfile` / `decodeAutoExposure` above.
    let decodeQuality: PipelineRenderer.Quality =
      asset.isRaw ? (wantsFull ? (AmazeFlag.isEnabled ? .amaze : .full) : quality) : .preview
    let requestedBaked: AdjustmentModel?
    do {
      requestedBaked = try Self.validatedBakedModel(for: asset)
    } catch {
      editSessionLogger.error(
        "Decode sidecar validation failed: \(error.localizedDescription, privacy: .public)")
      return nil
    }
    // Reuse an in-flight task only when it already satisfies the
    // caller's fullness requirement AND was launched for the same
    // profile + autoExposure + quality. A fast (sized) caller can join
    // any (same-identity) task; a refine (full) caller must NOT join a
    // sized task. #2143: quality must match too — a refine call
    // escalated to `.full`/`.amaze` must not join an in-flight
    // `.preview` fast task (or vice versa), which would silently hand
    // back the wrong-quality buffer.
    if let existing = decodePublicationTask, decodeCancelFlag != nil, decodeTaskAssetID == asset.id,
      decodeTaskSidecarURL == asset.sidecarURL,
      decodeTaskProfile == decodeProfile,
      decodeTaskAutoExposure == decodeAutoExposure,
      decodeTaskQuality == decodeQuality,
      Self.bakedModelsMatch(decodeTaskBakedModel, requestedBaked),
      !wantsFull || decodeTaskIsFull
    {
      // #951: JOIN an in-flight, identity-compatible decode. Do NOT create
      // or flip a cancel flag here — same-asset slider ticks during a cold
      // open share this one decode and its flag; nobody cancels until a
      // genuinely different decode supersedes it (the replace path below).
      guard let normalized = await existing.value else { return nil }
      do {
        guard
          Self.bakedModelsMatch(
            try Self.validatedBakedModel(for: asset), requestedBaked
          )
        else { return nil }
      } catch { return nil }
      return normalized
    }
    // #951: a DIFFERENT-identity decode is superseding the in-flight one
    // (different asset / profile / fullness) — abandon it. Flip its flag so
    // the Rust worker unwinds mid-stage instead of running to completion,
    // then drop our reference (the in-flight Task still holds its own).
    decodeCancelFlag?.requestCancel()
    decodeCancelFlag = nil
    decodeTask = nil
    decodePublicationTask = nil
    decodeTaskAssetID = nil
    decodeTaskSidecarURL = nil

    let decodeSignpostID = editSessionSignposter.makeSignpostID()
    let decodeState = editSessionSignposter.beginInterval("decode", id: decodeSignpostID)

    let extensionIsRaw = asset.isRaw
    let needsSniff =
      asset.primaryURL == nil
      && asset.hintExtension == nil
      && asset.explicitIsRaw == nil
    let decodeTarget = target
    // #951: a fresh cancel flag for THIS decode. Captured strongly by the
    // detached Task below (`[pipeline, cancelFlag]`) so it outlives the
    // synchronous FFI call the worker runs even if the actor's stored
    // reference is replaced/cleared meanwhile — no use-after-free on the
    // Rust side. Stored on the actor so the replace path / invalidate /
    // cancelAll can flip it to abandon this decode.
    let cancelFlag = CancelFlag()
    decodeCancelFlag = cancelFlag
    let task:
      Task<
        (
          CIImage, [Float]?, UInt32, WbSliderFrame?, Float, Float, Float, Bool, Bool, Bool,
          RawCameraSupport?, PipelineRenderer.Quality?
        )?,
        Never
      > =
        Task.detached(priority: .userInitiated) { [pipeline, cancelFlag, self] in
          var dispatchAsset = asset
          var dispatchIsRaw = extensionIsRaw
          if needsSniff, let provider = asset.bytesProvider {
            if let bytes = try? await provider() {
              if let detected = AssetRef.detectIsRaw(bytes: bytes) {
                dispatchIsRaw = detected
                // Surface the AUTHORITATIVE content sniff so the GPU
                // live path tags `inputShape` from the same signal the
                // decode uses, not the RAW-defaulting `AssetRef.isRaw`
                // (#1553). Only a definitive sniff is recorded — an
                // unrecognised signature leaves `resolvedIsRaw` nil so
                // callers fall back to `AssetRef.isRaw`.
                await self.recordResolvedIsRaw(asset.id, detected)
              }
              let cachedBytes = bytes
              let displayName = asset.displayName
              let hint: String? = {
                if dispatchIsRaw { return asset.hintExtension }
                if bytes.count >= 4 {
                  if bytes[0] == 0xFF, bytes[1] == 0xD8 { return "jpg" }
                  if bytes[0] == 0x89, bytes[1] == 0x50 { return "png" }
                  if bytes.count >= 8 {
                    if bytes[4] == 0x66, bytes[5] == 0x74,
                      bytes[6] == 0x79, bytes[7] == 0x70
                    {
                      return "heic"
                    }
                  }
                }
                return asset.hintExtension
              }()
              dispatchAsset = AssetRef(
                displayName: displayName,
                hintExtension: hint,
                stableID: asset.stableID,
                explicitIsRaw: dispatchIsRaw,
                bytesProvider: { cachedBytes }
              )
            }
          }

          if !dispatchIsRaw {
            // Fast phase passes a viewport `target` so ImageIO decodes
            // a downsampled thumbnail; refine passes `nil` for the
            // full-res decode (#785). Non-RAW has no noise profile.
            let nonRawImage = await mapleStageAsync("ImageIO non-RAW decode") {
              await pipeline.decodeSceneLinearNonRaw(
                asset: dispatchAsset, targetSize: decodeTarget
              )
            }
            guard let nonRawImage else { return nil }
            return (
              nonRawImage, [Float]?.none, UInt32(0), WbSliderFrame?.none, Float(1.0), Float.nan,
              Float(1.0),
              false, true, true, nil, nil
            )
          }
          let asset = dispatchAsset
          let sidecar: URL?
          do { sidecar = try Self.coldDecodeSidecar(requestedBaked) } catch { return nil }
          defer { if let sidecar { try? FileManager.default.removeItem(at: sidecar) } }
          // The session's staged file is also Auto Profile's source. A
          // bytes-FFI decode would use a different native cache key (Bytes
          // vs Path), demuxing the same RAW again for fitting. Only this
          // decode input changes shape; cache/normalization identity and
          // sidecar ownership still use the original asset below.
          let decodeAsset: AssetRef
          if asset.primaryURL == nil {
            do {
              let url = try await rawRenderSource.url(for: asset)
              try Task.checkCancellation()
              decodeAsset = AssetRef(url: url)
            } catch is CancellationError {
              return nil
            } catch {
              editSessionLogger.error(
                "RAW source staging failed: \(error.localizedDescription, privacy: .public)")
              return nil
            }
          } else {
            decodeAsset = asset
          }
          // RAW fast phase AND refine both route through the sized scene-
          // linear FFI (`maxLongEdge`) so the Rust decoder never allocates
          // a full-sensor-resolution buffer just because the viewport
          // asked for one (#785/#1637) — every caller passes a sized
          // target since #1637, so `quality` (not a `nil` target) is what
          // now distinguishes refine from fast. See `ImageEditPipeline.
          // refineDecodeQuality` for the escalation rule and its rationale.
          if let decodeTarget {
            let sizedResult = await mapleStageAsync("rust FFI scene-linear sized decode") {
              await pipeline.decodeSceneLinearSized(
                asset: decodeAsset, targetSize: decodeTarget, xmpPath: sidecar,
                quality: decodeQuality,
                profileOverride: decodeProfile, autoExposureOverride: decodeAutoExposure,
                cancel: cancelFlag
              )
            }
            guard let sizedResult else { return nil }
            return (
              sizedResult.image, sizedResult.noiseProfile, sizedResult.iso,
              sizedResult.wbFrame, sizedResult.aeGain, sizedResult.whitesAnchorEv,
              sizedResult.nrSamplingScale,
              sizedResult.hasLensCorrections,
              sizedResult.lensCorrectionCaInert, sizedResult.lensCorrectionDistortionInert,
              sizedResult.cameraSupport, decodeQuality
            )
          }
          // #940 — legacy full-resolution branch: `target == nil` no
          // longer occurs from any production call site (see above), but
          // stays as the correct behaviour for a hypothetical future nil-
          // target caller (e.g. a `renderFull()`-style path) — AMaZE when
          // AmazeFlag is enabled, otherwise Full.
          let refineResult = await mapleStageAsync("rust FFI scene-linear decode") {
            await pipeline.decodeSceneLinear(
              asset: decodeAsset, quality: decodeQuality, xmpPath: sidecar,
              profileOverride: decodeProfile, autoExposureOverride: decodeAutoExposure,
              cancel: cancelFlag
            )
          }
          guard let refineResult else { return nil }
          return (
            refineResult.image, refineResult.noiseProfile, refineResult.iso,
            refineResult.wbFrame, refineResult.aeGain, refineResult.whitesAnchorEv,
            refineResult.nrSamplingScale,
            refineResult.hasLensCorrections,
            refineResult.lensCorrectionCaInert, refineResult.lensCorrectionDistortionInert,
            refineResult.cameraSupport, decodeQuality
          )
        }
    decodeTask = task
    decodeTaskAssetID = asset.id
    decodeTaskSidecarURL = asset.sidecarURL
    decodeTaskIsFull = wantsFull
    decodeTaskProfile = decodeProfile
    decodeTaskAutoExposure = decodeAutoExposure
    decodeTaskQuality = decodeQuality
    decodeTaskBakedModel = requestedBaked

    // A joined request must await normalization and cache publication too, so
    // its returned pixels and subsequent snapshot describe the same decode.
    let publication = Task {
      let result = await task.value
      editSessionSignposter.endInterval("decode", decodeState)
      return await publishDecodedResult(
        result, asset: asset, requestedBaked: requestedBaked, wantsFull: wantsFull,
        decodeProfile: decodeProfile, decodeAutoExposure: decodeAutoExposure,
        cancelFlag: cancelFlag, normalize: normalize)
    }
    decodePublicationTask = publication
    return await publication.value
  }

  @discardableResult
  public func coalescedRefineDecode(
    asset: AssetRef,
    target: CGSize,
    decode: @escaping @Sendable () async -> CIImage?
  ) async -> CIImage? {
    let key = RefineDecodeKey(assetID: asset.id, target: target)
    if let existing = refineDecodeTasks[key] {
      editSessionLogger.debug(
        "coalescedRefineDecode joined in-flight task for \(target.width, format: .fixed(precision: 0))x\(target.height, format: .fixed(precision: 0))"
      )
      return await existing.task.value
    }
    refineDecodeSlotCounter &+= 1
    let slotID = refineDecodeSlotCounter
    let task = Task<CIImage?, Never>.detached(priority: .userInitiated) {
      await decode()
    }
    refineDecodeTasks[key] = RefineDecodeSlot(id: slotID, task: task)
    let result = await task.value
    if refineDecodeTasks[key]?.id == slotID {
      refineDecodeTasks[key] = nil
    }
    return result
  }

  // MARK: - Cache lifecycle (slice 2)

  public func invalidate() {
    decodedImage = nil
    decodedRawResolution = .zero
    decodedForAssetID = nil
    decodedBakedModel = nil
    decodedSidecarMtime = nil
    decodedSidecarURL = nil
    decodedIsFull = false
    // #951: abandon any in-flight cold decode — flip its flag so the Rust
    // worker unwinds, then drop our reference (the in-flight Task keeps its
    // own across the FFI call).
    decodeCancelFlag?.requestCancel()
    decodeCancelFlag = nil
    decodeTask = nil
    decodePublicationTask = nil
    decodeTaskAssetID = nil
    decodeTaskSidecarURL = nil
    decodeTaskIsFull = false
    decodeTaskProfile = nil
    decodeTaskBakedModel = nil
    decodeTaskAutoExposure = nil
    refineDecodeTasks.removeAll()
    decodedAtModel = nil
    decodedProfile = nil
    decodedAutoExposure = nil
    decodedQuality = nil
    decodedNoiseProfile = nil
    decodedISO = 0
    decodedWbFrame = nil
    decodedAeGain = 1.0
    decodedWhitesAnchorEv = .nan
    decodedNrSamplingScale = 1
    decodedHasLensCorrections = false
    decodedLensCorrectionCaInert = true
    decodedLensCorrectionDistortionInert = true
    decodedCameraSupport = nil
  }

  public func snapshot(forAsset asset: AssetRef) -> DecodedSnapshot {
    // #950: unchanged mtime skips the XMP parse. Autosaves of live-only
    // fields keep the baked model valid; accept their observed mtime so
    // later ticks return to this fast path instead of parsing indefinitely.
    // Capture before parsing: a concurrent write must remain detectable on
    // the next tick, never be accepted without comparing its baked model.
    let assetMatches = (decodedForAssetID == asset.id)
    let currentMtime = assetMatches ? EditSession.sidecarMtime(for: asset) : nil
    let isFresh: Bool
    if !assetMatches {
      isFresh = false
    } else if decodedSidecarURL == asset.sidecarURL,
      let mt = decodedSidecarMtime, currentMtime == mt
    {
      // File untouched since decode → baked model unchanged.
      isFresh = true
    } else {
      do {
        isFresh = Self.bakedModelsMatch(
          try Self.validatedBakedModel(for: asset), decodedBakedModel)
      } catch {
        isFresh = false
      }
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
      quality: decodedQuality,
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

}
