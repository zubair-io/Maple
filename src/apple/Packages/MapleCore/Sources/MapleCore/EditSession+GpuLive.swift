// EditSession+GpuLive.swift — the wgpu LIVE-render present branch (epic #925,
// P4b-apple / #1028).
//
// Always compiled (the GPU FFI is in the default xcframework now). Reached only
// when the runtime flag is on (`GpuLiveFlag.isEnabled`); with it off,
// `decodeAndRender` (EditSession+Render) runs the CPU + Metal + CIColorCube path
// byte-for-byte — the "flag-off == today" guarantee.
//
// ## Why a parallel present, not a `processSceneLinear` rewrite
//
// `ImageEditPipeline.processSceneLinear` is `(decoded: CIImage) -> CIImage`; the
// editor publishes that CIImage to `renderedPreview` and `CIImageView` rasters
// it. The wgpu chain produces NO CIImage — `present_chain_to_surface` goes f32
// storage buffer → `CAMetalLayer` drawable with no CPU readback (that IS the perf
// win). So the GPU path cannot branch INSIDE `processSceneLinear` without either
// reading the chain back to a CIImage (killing the win) or changing the return
// type (breaking every caller + the flag-off path). Instead it is a PARALLEL
// presentation path gated at the `decodeAndRender` call site: when the GPU path
// handles a phase it presents to the layer and returns `true`, and the caller
// SKIPS the CPU `processSceneLinear` + `renderedPreview =` publish. The CPU path
// stays exactly as it was for the flag-off fallback.
//
// ## The decode-boundary contract (the silent-bug trap)
//
// The buffer handed to the GPU session is the SAME decoded scene-linear CIImage
// the CPU path uses — Rec.2020 fp16, AE + capture-sharpening baked at decode, WB
// landed at the image's As-Shot (the strip XMP omits the WB fields —
// #1883/#1976). `makeGpuLiveParams` therefore passes
// `capture_sharpening: None`, does NOT re-run AE, and uses develop's ABSOLUTE WB
// (live temp/tint straight through). The on-screen result diverges from today's
// CPU pixels BY DESIGN (sharpen + nr_color move into the scene-linear chain at
// canonical positions; Auto Profile becomes curve + residual-LUT passes instead
// of a pre-composed CIColorCube) — convergence toward canonical `render`, not a
// regression. The colour-correctness proof is the raw-gpu host present-parity
// gate (≤ 1 LSB vs the CPU oracle), NOT a flag-on-vs-flag-off pixel diff.

import CoreImage
import Foundation

@MainActor
extension EditSession {
  /// Attempt to render `decoded` for this phase via the wgpu live chain and
  /// PRESENT it to the registered `CAMetalLayer`, returning `true` when the
  /// GPU path handled the frame (so `decodeAndRender` skips the CPU
  /// `processSceneLinear` + `renderedPreview` publish). Returns `false` —
  /// falling back to the CPU + Metal path — when:
  ///   * the runtime flag is off / no driver (a gpu build with `MAPLE_GPU_LIVE`
  ///     unset),
  ///   * no canvas layer is registered yet (the view hasn't laid out),
  ///   * the f32 readback or the session open fails (surfaced, then CPU),
  ///   * the present itself THREW (#1769) — `gpuPresentFailed` flips, the GPU
  ///     canvas leaf unmounts, and this same pass publishes via the CPU path
  ///     so a torn drawable never stays on glass.
  ///
  /// Non-RAW assets (pano PNG, JPEG, HEIF) are now also handled via the GPU
  /// live chain with `inputShape = LinearRec2020Fp16` (#1331): the CPU decode
  /// (`decodeSceneLinearNonRaw`) promotes the buffer to extended linear Rec.2020
  /// before upload, so the chain skips only `capture_sharpening` (not WB — WB
  /// stays engaged for the temperature/tint sliders to work).
  ///
  /// WB CONTRACT (#1734): non-RAW assets have no "as-shot" anchor — the buffer
  /// is already at the D65 white point (linearised at session open), so the
  /// slider must be a delta OFF D65, not off some as-shot CCT. This call site
  /// passes `asShotCCT/asShotTint = 6500.0/0.0` (never `nil`, never the raw
  /// as-shot values) whenever `resolvedIsRaw` is false, so
  /// `makeGpuLiveParams` always sees an explicit decoded anchor for non-RAW
  /// and composes `M_net = wb(live) · wb(6500, 0)⁻¹` — identity at the default
  /// slider position, shifting correctly as the user drags. The matching CPU
  /// refine path (`scene_linear_chain.rs` / `_f32_entry.rs`, #1734) anchors to
  /// the SAME D65 baseline for non-RAW shapes, so a drag shifts the image on
  /// the GPU-live chain and does NOT snap back on the next CPU refine tick.
  ///
  /// Upload-once contract: the decoded buffer is read back to f32 and
  /// uploaded to the `GpuLiveSession` only when the open session doesn't
  /// already COVER this request at the SAME upload identity (#2039,
  /// #2049) — a session opened at the viewport or the ≤2× refine size is
  /// reused for a smaller request (the presented buffer just supersamples
  /// down through the `CAMetalLayer`, bounded by that same ≤2× ceiling); a
  /// slider tick at stable-or-covered dims AND unchanged identity
  /// re-presents the GPU-resident upload with NO readback (the per-tick
  /// path stays readback-free — the 16 ms budget). A same-dims re-decode
  /// (a baked-field edit — highlightRecovery, captureSharpening*,
  /// sharpenRadius/Detail/Masking) bumps `decodeGeneration` even though
  /// dims don't change, forcing the re-open that dims-only coverage would
  /// have skipped — the fix for #2049 (a baked edit silently invisible
  /// until a resize).
  ///
  /// `gen` is the scheduler generation; a stale generation drops the present
  /// before it is issued (mirrors the CPU `renderedPreview =` gen-gate), and
  /// the driver additionally supersedes any present still queued behind the
  /// actor under a fast drag.
  ///
  /// `decodeGeneration` is the `RenderActor` write-generation of the buffer
  /// `decoded` came from (#2049); `appliedCrop` is the crop actually folded
  /// into `decoded` (`.identity` when no crop applies) — together they form
  /// the `GpuUploadIdentity` a same-dims reuse must match (#2039: a crop
  /// change alters the presented pixels even at unchanged dims).
  ///
  /// `noiseProfile`/`iso` (#2342) are this decode's `RenderActor` snapshot
  /// fields (`snapshot.noiseProfile`/`snapshot.iso`) — forwarded to
  /// `driver.open` on an actual (re-)open so the GPU live session's NLM
  /// pass gets the same per-pixel modulation the CPU refine chain already
  /// has. Unused when the open session is reused (`driver.isOpen` below);
  /// the reused session already carries the pair from ITS open.
  func presentViaGpuLive(
    decoded: CIImage,
    targetSize: CGSize?,
    gen: UInt64?,
    decodeGeneration: UInt64,
    appliedCrop: Crop,
    noiseProfile: [Float]? = nil,
    iso: UInt32 = 0
  ) async -> Bool {
    guard GpuLiveFlag.isEnabled, let driver = gpuLiveDriver else {
      editSessionLogger.notice("GPU-TRACE reject flag-or-driver gen=\(gen ?? 0)")
      return false
    }
    // #1637: very large sensors blow the iOS ~6 GB per-process limit on the
    // GPU-live path — its wgpu storage buffers (display-res) plus the
    // in-driver auto-profile fit accumulate across image switches and, with
    // the CPU develop, jetsam-kill the app (a device A/B confirmed the
    // 100 MP reference RAW OOMs with GPU-live ON, survives with it OFF).
    // Fall back to the proven CPU two-phase path above the sensor threshold
    // AND when the size is unknown (`nativeImageSize == .zero`) — a
    // bytes-provider / PhotoKit asset seeds its size ASYNchronously, so a
    // 100 MP library photo can still read `.zero` here and must NOT take
    // the GPU path on spec (that OOM'd). GPU-live resumes once the size
    // seeds and proves small (see `gpuLiveSupportsSensor`).
    // `MAPLE_MEM_PROBE` forces the GPU path on regardless of sensor size so
    // the large-RAW GPU footprint can be MEASURED on device (#1647 M1); the
    // production gate below otherwise routes large sensors to CPU.
    let sensorLongEdge = max(nativeImageSize.width, nativeImageSize.height)
    guard
      MemoryProbe.isEnabled
        || ImageEditPipeline.gpuLiveSupportsSensor(longEdge: sensorLongEdge)
    else {
      editSessionLogger.notice(
        "GPU-TRACE reject large-sensor gen=\(gen ?? 0) longEdge=\(sensorLongEdge, format: .fixed(precision: 0))"
      )
      return false
    }
    // Non-RAW assets (pano PNG, JPEG, HEIF) use the GPU live chain with
    // `inputShape = 1` (LinearRec2020Fp16): `decodeSceneLinearNonRaw` already
    // promotes the buffer to extended linear Rec.2020 via CoreImage. The chain
    // skips only capture_sharpening (not WB — WB stays engaged with
    // decoded=6500/0 so the user's temperature/tint slider edits land
    // correctly). All formats that reach here have a valid `decoded` CIImage
    // from the existing decode dispatch. (#1331)
    //
    // Prefer the content-sniffed classification recorded by `sharedDecode`
    // over `asset.isRaw`. Bytes-backed PhotoKit / Self-Hosted assets carry
    // no URL or extension, so `asset.isRaw` defaults them to RAW and the GPU
    // tail would run AgX on a non-RAW buffer — crushing white to grey (#1553).
    // URL/extension-backed assets never sniff (`resolvedIsRaw` is nil) and
    // fall back to `asset.isRaw`, which classifies them correctly up front.
    let resolvedIsRaw = await renderActor.resolvedIsRaw(for: asset.id) ?? asset.isRaw
    let inputShape: UInt32 = resolvedIsRaw ? 0 : 1
    guard driver.hasLayer else {
      editSessionLogger.notice("GPU-TRACE reject no-layer gen=\(gen ?? 0)")
      return false
    }

    let m = renderModel
    let pipeline = self.pipeline

    let dims = Self.gpuTargetDims(for: decoded, targetSize: targetSize, pipeline: pipeline)
    guard let dims else {
      editSessionLogger.notice(
        "GPU-TRACE reject nil-dims decoded.extent=\(decoded.extent.width)x\(decoded.extent.height) target=\(targetSize.map { "\($0.width)x\($0.height)" } ?? "nil")"
      )
      return false
    }
    editSessionLogger.notice(
      "GPU-TRACE enter gen=\(gen ?? 0) dims=\(dims.width)x\(dims.height) profile=\(String(describing: m.profile), privacy: .public)"
    )
    MemoryProbe.sample("gpu-enter dims=\(dims.width)x\(dims.height) sensor=\(Int(sensorLongEdge))")

    // Drop obsolete work before readback, not just before presentation (#3360).
    if let gen {
      guard gen == (await renderActor.currentGeneration()), !Task.isCancelled else { return true }
    }
    guard !Task.isCancelled else { return true }
    let uploadIdentity = GpuUploadIdentity(decodeGeneration: decodeGeneration, crop: appliedCrop)
    if !driver.isOpen(coveringWidth: dims.width, height: dims.height, identity: uploadIdentity) {
      do {
        try await driver.open(
          width: dims.width, height: dims.height,
          inputShape: inputShape, identity: uploadIdentity,
          noiseProfile: noiseProfile, iso: iso
        ) {
          try Task.checkCancellation()
          guard let buf = pipeline.sceneLinearFloats(from: decoded, targetSize: targetSize) else {
            throw GpuLiveError(message: "GPU pixel readback failed")
          }
          try Task.checkCancellation()
          return buf.pixels
        }
        MemoryProbe.sample("gpu-open dims=\(dims.width)x\(dims.height)")
      } catch is CancellationError {
        return true  // Superseded work must not allocate a CPU fallback either.
      } catch {
        editSessionLogger.error(
          "GPU live open failed: \(error.localizedDescription, privacy: .public) — CPU fallback")
        return false
      }
    }

    // #2683 round 2: bail BEFORE the Auto Profile fit / film-lut sync
    // below if a newer render has already superseded this one — both of
    // those calls mutate persistent `driver` state (the fitted cube, and
    // `currentFilmLutKey` via `syncFilmLutForPresent`) as a side effect,
    // independent of whether THIS present goes on to actually run. Left
    // unguarded, a present that's ABOUT to be dropped by the late
    // generation gate below still marks the driver "in sync" with the
    // look this call resolved — and since `syncFilmLutForPresent`'s own
    // guard is "skip the push when the key already matches," a later,
    // genuinely-live present for the SAME look sees no key change and
    // may skip work assuming the drawable already reflects it, when in
    // fact the frame that would have shown it was the one just dropped.
    // This early check shrinks that window; the original late check
    // below stays as the final guard against staleness that develops
    // during THIS call's own awaits (the readback/open and the fit).
    if let gen {
      let live = await renderActor.currentGeneration()
      guard gen == live, !Task.isCancelled else {
        editSessionLogger.debug(
          "GPU live present gen=\(gen) stale before film sync (current=\(live)), dropping")
        return true  // handled (intentionally dropped) — do NOT fall to CPU
      }
    }

    // Cloud RAWs need the same fit as local files. The session stages
    // their bytes once for the path-only FFI (#3357).
    if resolvedIsRaw, m.profile == .auto,
      let url = try? await renderActor.rawRenderSource.url(for: asset)
    {
      let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
      let accessing = scope.startAccessingSecurityScopedResource()
      defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
      await driver.fitAutoProfileIfNeeded(
        rawPath: url.path, model: m, quality: .preview)
    }

    // Film look (epic #2683, Task 10): resolve + push BEFORE this present,
    // mirroring the Auto Profile fit above rather than pushing from
    // `model`'s `didSet` (a property observer can't `await`, so a
    // didSet-time push always raced the render it was supposed to
    // precede — see `syncFilmLutForPresent`'s doc for the history).
    await syncFilmLutForPresent(driver: driver)

    // Generation gate: drop a superseded present before issuing it (the CPU
    // path drops at `renderedPreview =`; the GPU present has no post-hoc
    // gate, so we check here AND let the driver supersede the queued one).
    if let gen {
      let live = await renderActor.currentGeneration()
      guard gen == live, !Task.isCancelled else {
        editSessionLogger.debug("GPU live present gen=\(gen) stale (current=\(live)), dropping")
        return true  // handled (intentionally dropped) — do NOT fall to CPU
      }
    }

    renderError = nil
    // NOTE (#1769): the driver no longer writes `layer.drawableSize` here —
    // wgpu's `surface.configure` is the single writer (see
    // `GpuLiveDriver.register`). The old host-side write invalidated the
    // drawable pool on every 1-px disagreement, un-protected by the
    // settle double-present.
    editSessionLogger.notice(
      "GPU-TRACE present begin gen=\(gen ?? 0) dims=\(dims.width)x\(dims.height)")
    var presentErr: Error? = nil
    // #1781/#1976: with a decode-exported slider frame the delta
    // anchors at the frame's own as-shot pair (`wbDeltaAnchor` — the
    // WB the strip-XMP decode actually baked) and the FFI derives the
    // matrix with the frame's own calibration — matching the CPU tick
    // chain and a fresh full develop. Frame-less RAW keeps the legacy
    // pre-decode as-shot anchor; non-RAW keeps the D65 baseline
    // (#1734).
    let liveWbFrame = resolvedIsRaw ? wbSliderFrame : nil
    let anchor = wbDeltaAnchor
    let didPresent = await driver.present(
      model: m,
      asShotCCT: resolvedIsRaw ? (anchor?.temperature ?? asShotCCT) : 6500.0,
      asShotTint: resolvedIsRaw ? (anchor?.tint ?? asShotTint) : 0.0,
      wbFrame: liveWbFrame,
      scopeEnabled: scopeEnabled,
      scopeLayer: scopeLayerIndex
    ) { [weak self] error in
      presentErr = error
      self?.renderError = error
    }
    // Only overwrite on an actual new sample — mirrors the driver's own
    // "one-off readback miss leaves the previous sample in place"
    // contract one layer up. Gated on `scopeEnabled` too, so turning the
    // HUD off stops the needless re-publish of a now-stale sample every
    // tick (the driver's own `lastScopeSample` isn't cleared on
    // disable, it just stops updating).
    // A distinct model gets its own priming budget (#3387); without
    // this a readback that once stalled would leave every later edit
    // one behind for the rest of the session.
    if scopeTick.primedForModel != m {
      scopeTick.primedForModel = m
      scopeTick.primingTicks = 0
    }
    // The sample a present hands back describes the PREVIOUS present's
    // model (one-tick-late readback). Track which model the sample the
    // HUD currently shows was taken at; a present that delivers nothing
    // new leaves that attribution where it was — it does NOT become
    // current just because the same model was presented again.
    let deliveredDescribes = scopeTick.lastPresentedModel ?? m
    let decision = Self.scopeTickDecision(
      enabled: scopeEnabled,
      sample: driver.lastScopeSample,
      publishedFrame: scopeTick.publishedFrame,
      deliveredSampleIsCurrent: deliveredDescribes == m,
      heldSampleIsCurrent: scopeTick.shownSampleModel == m,
      ticks: scopeTick.primingTicks,
      maxTicks: ScopeTickState.maxPrimingTicks)
    scopeTick.lastPresentedModel = m
    if let sample = driver.lastScopeSample {
      let centroidText = sample.centroidAngleDeg.map { String(format: "%.1f", $0) } ?? "nil"
      let publishedText = scopeTick.publishedFrame.map(String.init) ?? "none"
      let hueText =
        m.localAdjustments.first.flatMap(\.adjustments.hue).map { String(format: "%.0f", $0) }
        ?? "nil"
      editSessionLogger.notice(
        "GPU-TRACE scope gen=\(gen ?? 0) hue=\(hueText, privacy: .public) frame=\(sample.frame) published=\(publishedText, privacy: .public) total=\(sample.total) centroid=\(centroidText, privacy: .public) deliveredCurrent=\(deliveredDescribes == m) heldCurrent=\(self.scopeTick.shownSampleModel == m) publish=\(decision.publish) prime=\(decision.prime) ticks=\(self.scopeTick.primingTicks)"
      )
    } else {
      editSessionLogger.notice("GPU-TRACE scope gen=\(gen ?? 0) no sample yet")
    }
    if decision.publish, let scope = driver.lastScopeSample {
      scopeSample = scope
      scopeTick.publishedFrame = scope.frame
      scopeTick.shownSampleModel = deliveredDescribes
      if deliveredDescribes == m { scopeTick.primingTicks = 0 }
    }
    if decision.prime {
      // #3387 — the readback is one tick late, so a DISCRETE edit (one
      // present) can only ever show the previous edit's scope: the
      // sample this present delivered describes the model presented
      // BEFORE it, and the sample for the current model is read by
      // the next present, which an idle canvas never issues. Same
      // shape as the #3344 first-sample priming below, generalised.
      scopeTick.primingTicks += 1
      _scheduleRender(phase: .fast)
    } else if scopeEnabled, scopeSample == nil,
      scopeTick.primingTicks < ScopeTickState.maxPrimingTicks
    {
      // #3344 — the GPU scope readback is one tick late BY DESIGN:
      // `take_scope_stats` reads the slot the PREVIOUS present wrote
      // (see `raw-gpu/src/live_session/scope.rs`), so the first
      // present after the HUD arms `scopeEnabled` can never carry a
      // sample. On a canvas the user is actively editing that costs
      // nothing — the next slider tick presents again and the sample
      // lands. On an IDLE canvas there is no next tick: opening an
      // image with the HUD already on presented exactly once and the
      // scope sat empty until the user happened to touch a slider.
      //
      // Prime it with one more render so the second tick happens on
      // its own. Bounded, and only while no sample has ever arrived,
      // so a readback that genuinely never produces one (mapping
      // error, scope pass disabled downstream) settles after a few
      // ticks instead of spinning renders forever.
      scopeTick.primingTicks += 1
      _scheduleRender(phase: .fast)
    }
    if let presentErr {
      // NO silent failure (#1769): a thrown present means nothing (or a
      // torn frame) is on glass and the GPU path has no repaint of its
      // own. Returning `false` sends this same `decodeAndRender` pass
      // down the CPU `processSceneLinear` + `renderedPreview` publish,
      // and `gpuPresentFailed` unmounts the GPU canvas leaf so the CPU
      // preview is actually visible. Pre-#1769 this path returned `true`
      // ("handled"), leaving a stale/torn drawable on screen with no
      // recovery until the next successful GPU present.
      gpuPresentFailed = true
      editSessionLogger.notice(
        "GPU-TRACE present FAILED gen=\(gen ?? 0), falling back to CPU canvas: \(presentErr.localizedDescription, privacy: .public)"
      )
      return false
    }
    // A cancelled/native-skipped submission is handled, but did not publish
    // pixels. Do not wake histograms or claim that a stale frame is ready.
    guard didPresent, !Task.isCancelled else { return true }
    if let gen, gen != (await renderActor.currentGeneration()) { return true }
    editSessionLogger.notice("GPU-TRACE present OK gen=\(gen ?? 0)")
    lastPublishedRenderGeneration = gen
    if !gpuFramePresented { gpuFramePresented = true }
    histogramState.framePresented()
    editSessionSignposter.emitEvent("GPU frame submitted")
    // GPU analog of the CPU publish clear (#1221): `decodeAndRender` returns
    // early on a successful GPU present and never reaches its `renderedPreview`
    // block, so the cold-open indicator must be settled HERE too — otherwise
    // it stays stuck on RAWs using the (default) GPU live canvas. Gated on
    // `!isFullQualityDecoding` so the embedded-preview presents during the
    // decode don't clear it early, exactly as the CPU path. (Copilot #1222)
    if isResolvingFirstFrame && !isFullQualityDecoding {
      isResolvingFirstFrame = false
      editSessionLogger.notice(
        "loading indicator HIDDEN — first full-quality frame presented (GPU live, gen=\(gen ?? 0))"
      )
      // #3363: the existing editor-exit readback populates the preview cache.
      // Reading back here occupies the GPU actor just as editing becomes ready.
    }
    editSessionLogger.debug(
      "GPU live presented gen=\(gen ?? 0) \(dims.width)x\(dims.height)")
    return true
  }

  /// Whether the ACTIVE canvas currently has a frame on screen — the input the
  /// loading spinner + `canvas-render-ready` sentinel need. The GPU live path's
  /// canvas IS the `CAMetalLayer` (`gpuFramePresented`); the CPU path's canvas
  /// is `renderedPreview`. Keyed on the active path so neither a hydration-seeded
  /// `renderedPreview` (GPU path) nor a hardcoded constant drives readiness. Pure
  /// (all inputs explicit) so it is unit-testable without env/flags, and
  /// `nonisolated` so it's callable off the MainActor. See #1069.
  public nonisolated static func canvasHasFrame(
    gpuActive: Bool,
    gpuFramePresented: Bool,
    hasRenderedPreview: Bool
  ) -> Bool {
    gpuActive ? gpuFramePresented : hasRenderedPreview
  }

  /// Whether the cold-open loading indicator should be visible: while the
  /// cold-open is still resolving its first full-quality frame (so it stays up
  /// from open, through the sub-second preview AND the decode, until the real
  /// image actually publishes), or in the no-preview blank-canvas window
  /// (`isRendering && !hasOnscreenFrame`). Pure → unit-testable; `nonisolated`
  /// like `canvasHasFrame`. #1201 / #1069 follow-up.
  public nonisolated static func shouldShowLoadingIndicator(
    isResolvingFirstFrame: Bool,
    isRendering: Bool,
    hasOnscreenFrame: Bool
  ) -> Bool {
    isResolvingFirstFrame || (isRendering && !hasOnscreenFrame)
  }

  /// The post-prescale pixel dims the GPU session/layer use for `decoded` at
  /// `targetSize` — the exact extent `sceneLinearFloats` produces, computed
  /// WITHOUT a readback so the open/no-op decision is cheap. Runs the same
  /// crop calculation as the readback without building its CoreImage graph.
  /// `nil` on a degenerate extent.
  private static func gpuTargetDims(
    for decoded: CIImage,
    targetSize: CGSize?,
    pipeline: ImageEditPipeline
  ) -> (width: Int, height: Int)? {
    let extent = pipeline.prescaledExtent(of: decoded, targetSize: targetSize)
    let w = Int(extent.width.rounded())
    let h = Int(extent.height.rounded())
    guard w > 0, h > 0 else { return nil }
    return (w, h)
  }
}

extension EditSession {
  /// What to do with the driver's scope sample after a present (#3387).
  ///
  /// `publish` — the driver holds a sample whose `frame` differs from the
  /// last one published, i.e. this present actually delivered new stats.
  /// `prime` — the scope is on and the sample the HUD will show after this
  /// present (the delivered one if fresh, else the one already shown)
  /// describes an OLDER model than the one just presented — the readback
  /// is one tick late, so a present's sample belongs to the present before
  /// it — and the per-model budget allows one more tick. Pure so the rule
  /// is unit-tested without a GPU.
  nonisolated static func scopeTickDecision(
    enabled: Bool,
    sample: ScopeSample?,
    publishedFrame: UInt64?,
    deliveredSampleIsCurrent: Bool,
    heldSampleIsCurrent: Bool,
    ticks: Int,
    maxTicks: Int
  ) -> (publish: Bool, prime: Bool) {
    guard enabled, let sample else { return (false, false) }
    let fresh = sample.frame != publishedFrame
    // After this present the HUD shows either the delivered sample (if
    // fresh) or whatever it already showed. Prime whenever THAT still
    // describes an older model than the one just presented.
    let shownIsCurrent = fresh ? deliveredSampleIsCurrent : heldSampleIsCurrent
    return (fresh, !shownIsCurrent && ticks < maxTicks)
  }
}

/// GPU scope readback bookkeeping on `EditSession` (#3344, #3387).
struct ScopeTickState {
  /// How many extra render ticks the GPU path may schedule to coax a
  /// sample out of its one-tick-late readback. Small on purpose: two
  /// ticks is all a healthy readback needs, the third is slack for a
  /// present cancelled by a real edit.
  static let maxPrimingTicks = 3
  /// Extra ticks spent so far for the current budget.
  var primingTicks = 0
  /// Frame number of the last sample actually published to the HUD, so a
  /// present that hands back the same frame is recognised as a one-tick-
  /// late miss rather than re-published as if fresh.
  var publishedFrame: UInt64?
  /// The model handed to the previous present — what the sample the NEXT
  /// present delivers actually describes (one-tick-late readback).
  var lastPresentedModel: AdjustmentModel?
  /// The model the sample currently on the HUD was taken at. Stays put
  /// when a present delivers nothing new, which is exactly the case that
  /// must keep priming.
  var shownSampleModel: AdjustmentModel?
  /// The model the current priming budget belongs to — each distinct
  /// model gets its own, so a stalled readback cannot leave every later
  /// edit one behind for the rest of the session.
  var primedForModel: AdjustmentModel?
}
