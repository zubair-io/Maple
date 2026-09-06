// GpuLiveDriver.swift — the EditSession-owned driver for the wgpu live render
// path (epic #925, P4b-apple / #1028).
//
// Always compiled, but only instantiated when the runtime flag is on
// (`GpuLiveFlag.isEnabled` — `EditSession.gpuLiveDriver` is `nil` otherwise). Flag
// OFF = the editor uses the CPU + Metal + CIColorCube path
// (`processSceneLinear` → `renderedPreview` → `CIImageView`) byte-for-byte.
//
// ## Role
//
// Bridges the EditSession two-phase scheduler to the serialized `GpuLiveSession`
// + the `CAMetalLayer` the canvas view hosts. The CPU path publishes a `CIImage`
// to `renderedPreview`; the GPU path instead presents directly to the layer (no
// CIImage, no `renderedPreview` write). So this is a PARALLEL presentation path,
// not a rewrite of `processSceneLinear` — which stays untouched (the flag-off
// guarantee).
//
// ## What it owns
//
//   * the `GpuLiveSession` (upload-once per dims; re-opened on a viewport ⇄ full
//     resize, pairing with the sized-fast / full-refine decode split);
//   * a weak reference to the registered `CAMetalLayer` (the view owns the layer's
//     lifetime; the driver presents into it);
//   * the per-image Auto Profile artifacts (fit once on open, via the session).
//
// ## Serialization + cancellation
//
// `GpuLiveSession` is an `actor` (one render in flight — the `!Send` Rust
// context). The driver's `present` calls hop onto it; the EditSession scheduler's
// GENERATION GUARD (the same `gen == live` check the CPU path uses before
// `renderedPreview = image`) decides whether a finished present is still current —
// a stale present (superseded by a newer edit) is simply not the one that lands on
// screen, exactly as today. A per-present `CancelFlag` lets a queued-but-stale
// present bail at the FFI entry before burning a GPU cycle.

import Foundation
import QuartzCore
import os

private let gpuDriverLog = Logger(subsystem: "app.justmaple.aperture", category: "gpu-live-driver")
private let gpuDriverSignposter = OSSignposter(
  subsystem: "app.justmaple.aperture", category: .pointsOfInterest)

/// Identity of the pixel buffer currently uploaded to the open
/// `GpuLiveSession` (#2039, #2049). A same-dims present must still force a
/// re-open when either component changes:
///
///   * `decodeGeneration` — the `RenderActor` write-generation the uploaded
///     buffer came from. A baked-field edit (highlightRecovery,
///     captureSharpeningAmount/Sigma, the unsharp sharpenRadius/Detail/
///     Masking) forces a fresh decode at the SAME target dims; dims alone
///     can't detect that, so reusing the session on dims would silently
///     present the live chain over the STALE uploaded buffer (#2049).
///   * `crop` — the crop actually folded into the uploaded pixels
///     (`.identity` when no crop applies). A crop CHANGE alters
///     `CropImageStage.apply`'s output — even at a pixel size that happens
///     to coincide with the previous crop's — so dims coverage alone can't
///     stand in for it either (#2039).
public struct GpuUploadIdentity: Equatable, Sendable {
  public let decodeGeneration: UInt64
  public let crop: Crop

  public init(decodeGeneration: UInt64, crop: Crop) {
    self.decodeGeneration = decodeGeneration
    self.crop = crop
  }
}

/// Drives the wgpu live render path for one EditSession: owns the per-dims
/// `GpuLiveSession`, the registered `CAMetalLayer`, and the per-image Auto Profile
/// fit. `@MainActor` because it is created/registered/invoked from EditSession
/// (also `@MainActor`); the heavy GPU work hops onto the `GpuLiveSession` actor.
@MainActor
public final class GpuLiveDriver {
  /// The current session (one set of dims). `nil` until the first open; replaced
  /// on a dims change. Held strongly — it owns the uploaded image + GPU buffers.
  private(set) var session: GpuLiveSession?
  private var sessionRevision: UInt64 = 0
  private var sessionPreparation: Task<GpuLiveSession, Error>?
  // Shared teardown barrier: queued replacements retain no f32 readback.
  // Internal so concurrency tests can suspend teardown deterministically.
  var sessionTeardown: Task<Void, Never>?
  /// Dims the current `session` was opened at; a present that isn't COVERED by
  /// these dims (either axis smaller than requested) forces a re-open
  /// (upload-once-and-reuse is per-covering-dims, #2039 — see `isOpen`).
  private var sessionDims: (width: Int, height: Int)?

  /// Identity of the pixels currently uploaded to `session` (#2039, #2049) —
  /// the decode generation + crop `open` was last called with. A present
  /// whose requested identity doesn't match this, even at covered dims,
  /// forces a re-open (see `GpuUploadIdentity`).
  private var uploadedIdentity: GpuUploadIdentity?

  /// The canvas layer to present into. Weak — the SwiftUI view owns it; if the
  /// view goes away the driver simply has nothing to present to.
  private weak var layer: CAMetalLayer?

  /// The `CanvasColorSpace` last tagged onto `layer.colorspace` (#1338) —
  /// tracked so `present()` only touches the layer when the user-facing
  /// setting actually changed, not on every tick.
  private var taggedColorSpace: CanvasColorSpace?

  /// The surface-cache generation token (#1769). Forwarded to every
  /// `maple_gpu_present_chain`; the Rust side keys its PROCESS-WIDE present
  /// surface on `(generation, layer, dims)`. Bumped when:
  ///   * a DIFFERENT `CAMetalLayer` instance registers (SwiftUI recreated the
  ///     canvas view — covers malloc address reuse, where the raw pointer
  ///     alone would falsely match a dead layer), or
  ///   * the layer's `drawableSize` diverges from the last successful
  ///     present's dims at an otherwise-unchanged key (an external
  ///     re-derivation wgpu cannot see — see `presentDivergenceCheck`).
  /// A bump forces a deterministic old-surface teardown + fresh configure +
  /// the settle double-present on the Rust side.
  private var surfaceGeneration: UInt64 = 0

  /// The `(generation, dims)` of the most recent SUCCESSFUL present — the
  /// state the Rust cache is known to be configured at. Drives the
  /// drawableSize-divergence check: only when the upcoming present would hit
  /// the no-configure fast path (same generation, same dims) does a
  /// drawableSize mismatch mean an external invalidation.
  private var lastPresentedKey: (generation: UInt64, width: Int, height: Int)?

  /// The RAW path + decode quality for the Auto Profile fit (set on open).
  private var autoProfileFitDone = false

  /// The current film-look lattice (epic #2683, Task 10), if any — pushed by
  /// `EditSession` via `setFilmLut`/`clearFilmLut` whenever
  /// `model.filmLook` resolves through `FilmLutStore`. Remembered here
  /// (not just forwarded to the current `GpuLiveSession`) because `open`
  /// REPLACES the session on every dims change (viewport ⇄ full-res, a
  /// crop edit, a baked-field re-decode) — unlike `autoProfileFitDone`,
  /// which re-fits per open, the film lattice doesn't need re-decoding,
  /// just re-applying to the fresh session so a look survives a resize.
  private var filmLut: (data: [Float], size: Int, key: UInt32)?

  /// Cache the film-look lattice and push it to the currently-open session
  /// (if any) — future `open` calls also re-apply it (see `filmLut`).
  public func setFilmLut(data: [Float], size: Int, key: UInt32) async {
    filmLut = (data, size, key)
    await session?.setFilmLut(data: data, size: size, key: key)
  }

  /// Clear the film-look lattice — the current session (if any) and every
  /// future `open` go back to identity (no look).
  public func clearFilmLut() async {
    filmLut = nil
    await session?.clearFilmLut()
  }

  /// The content-identity key of the currently-loaded film-look lattice,
  /// `nil` for "no look". A synchronous MainActor read (no actor hop) —
  /// `EditSession.syncFilmLutForPresent` compares this against a freshly
  /// resolved key to skip the `await` push entirely on the common
  /// steady-state present where the look hasn't changed.
  public var currentFilmLutKey: UInt32? { filmLut?.key }

  /// The input-shape tag for the open session (#1331): 0 = PostDcpRec2020Fp16
  /// (RAW, all stages), 1 = LinearRec2020Fp16 (pano PNG, skip WB+CS). Stored at
  /// `open` time and forwarded to every `present` so the chain knows which leading
  /// stages to run. 0 is the safe default (preserves pre-#1331 RAW behaviour).
  private var inputShape: UInt32 = 0

  /// Rolling per-tick GPU render+present latency for the in-app frame-time HUD
  /// (#1053). The driver records every REAL present's elapsed ms here (cancelled
  /// presents return `nil` and are skipped), but ONLY when `GpuHudFlag.isEnabled`
  /// — so a gpu build with the HUD off does zero extra work on the render path.
  /// `@Observable`, so `GpuFrameTimeHud` re-renders as frames land. Owned
  /// by the driver (the natural recorder); the view reads it via
  /// `session.gpuLiveDriver?.frameStats`.
  public let frameStats = GpuFrameTimeStats()

  /// Cancel flag of the most-recent present. The CPU path drops a stale
  /// render at the `renderedPreview =` generation gate; the GPU present has
  /// no such gate — once `present_chain_to_surface` runs, it's on screen. So
  /// before issuing a new present we FLIP this (the FFI bails at its entry →
  /// `RC_PRESENT_CANCELLED`) so a queued-but-superseded present under a fast
  /// slider drag never lands after the newer one. The `GpuLiveSession` actor
  /// serializes the presents themselves (one render in flight), so this is
  /// purely the "supersede the one already queued" guard. Held weakly: it's
  /// owned for the duration of its present call by `present(...)` below.
  private weak var inFlightCancel: CancelFlag?

  public init() {}

  /// Register the canvas layer the driver presents into. Called by
  /// `GpuLiveCanvasView` when its `CAMetalLayer` is created / its host view lays
  /// out. Idempotent for the SAME layer instance; a different instance bumps
  /// the surface generation so the Rust cache can never present against a
  /// recycled layer address (#1769).
  ///
  /// NOTE (single-writer contract, #1769): the driver does NOT write
  /// `layer.drawableSize` — wgpu's `surface.configure` owns it. Host-side
  /// writes (the old `layoutSubviews` sizing + `setDrawableSize`) invalidated
  /// the CAMetalLayer drawable pool without wgpu knowing, so a single present
  /// after a layout pass could land on a freshly-invalidated pool: the iPad
  /// partial-render splice, with none of #1743's double-present protection.
  public func register(layer: CAMetalLayer) {
    if layer !== self.layer {
      inFlightCancel?.requestCancel()
      self.layer = layer
      surfaceGeneration &+= 1
      // A newly-registered layer has no colorspace tag applied yet
      // (`GpuLiveCanvasController.init()` no longer sets one — the
      // first `present()` below is now the sole tagger) — clear the
      // cache so `retagLayerIfNeeded` doesn't skip tagging THIS layer
      // just because it matches the PREVIOUS layer's last-applied
      // value.
      taggedColorSpace = nil
    }
  }

  /// Keep `layer.colorspace` in lockstep with `target` (#1338) — the exact
  /// `CanvasColorSpace` `present()` below is ABOUT to pass into
  /// `GpuLiveParams`/`PipelineRenderer` for `target_primaries`. `present()`
  /// reads `CanvasColorSpace.current` ONCE and hands the SAME value to
  /// both this call and the params call — two independent `.current` reads
  /// a moment apart could observe a mid-flight Settings change differently
  /// and reproduce #1512 (CoreAnimation double- or non-converting the
  /// primaries) for exactly one frame (Copilot review on #3192).
  private func retagLayerIfNeeded(_ layer: CAMetalLayer, to target: CanvasColorSpace) {
    guard target != taggedColorSpace else { return }
    let name: CFString = target == .displayP3 ? CGColorSpace.displayP3 : CGColorSpace.sRGB
    guard let space = CGColorSpace(name: name) else { return }
    layer.colorspace = space
    taggedColorSpace = target
  }

  /// Reuse a covering upload or replace it after the previous session closes.
  /// Pixel readback is lazy: only the newest non-cancelled request may allocate
  /// it AFTER teardown. MainActor reentrancy at `close()` previously let every
  /// slider tick retain a readback and reopen the same old session (#3360).
  public func open(
    width: Int, height: Int, inputShape: UInt32 = 0,
    identity: GpuUploadIdentity, noiseProfile: [Float]? = nil, iso: UInt32 = 0,
    pixels: @escaping @Sendable () throws -> [Float]
  ) async throws {
    try Task.checkCancellation()
    guard !isOpen(coveringWidth: width, height: height, identity: identity) else { return }
    sessionRevision &+= 1
    let revision = sessionRevision
    beginSessionTeardown()
    if let teardown = sessionTeardown { await teardown.value }
    try Task.checkCancellation()
    guard revision == sessionRevision else { throw CancellationError() }
    sessionTeardown = nil
    // CI readback and native context/upload creation can take hundreds of ms.
    // Keep them off MainActor, with one retained preparation behind teardown.
    let preparation = Task.detached(priority: .userInitiated) {
      try Task.checkCancellation()
      let data = try pixels()
      try Task.checkCancellation()
      let prepared = try GpuLiveSession(
        pixels: data, width: width, height: height, noiseProfile: noiseProfile, iso: iso)
      if Task.isCancelled {
        await prepared.close()
        throw CancellationError()
      }
      return prepared
    }
    sessionPreparation = preparation
    let s: GpuLiveSession
    do {
      s = try await withTaskCancellationHandler {
        try await preparation.value
      } onCancel: {
        preparation.cancel()
      }
    } catch {
      if revision == sessionRevision { sessionPreparation = nil }
      throw error
    }
    // A superseding request owns the preparation's teardown barrier.
    guard revision == sessionRevision else { throw CancellationError() }
    if Task.isCancelled {
      // Keep this completed preparation represented while its actor closes.
      // A newer open must join cleanup before allocating another upload.
      beginSessionTeardown()
      if let teardown = sessionTeardown { await teardown.value }
      throw CancellationError()
    }
    sessionPreparation = nil
    self.session = s
    self.sessionDims = (width, height)
    self.uploadedIdentity = identity
    self.autoProfileFitDone = false
    self.inputShape = inputShape
    if let filmLut {
      await s.setFilmLut(data: filmLut.data, size: filmLut.size, key: filmLut.key)
    }
    try Task.checkCancellation()
    guard revision == sessionRevision else { throw CancellationError() }
    gpuDriverLog.debug("opened GPU live session \(width)x\(height) inputShape=\(inputShape)")
  }

  /// Clear coverage before suspending and share the old actor's close with
  /// every waiter. Teardown must finish even when its requesting render cancels.
  private func beginSessionTeardown() {
    inFlightCancel?.requestCancel()
    let old = session
    let preparation = sessionPreparation
    guard old != nil || preparation != nil else { return }
    preparation?.cancel()
    sessionPreparation = nil
    session = nil
    sessionDims = nil
    uploadedIdentity = nil
    autoProfileFitDone = false
    let previous = sessionTeardown
    sessionTeardown = Task {
      if let previous { await previous.value }
      if let old { await old.close() }
      if let preparation, let prepared = try? await preparation.value {
        await prepared.close()
      }
    }
  }

  /// Fit the Auto Profile curve + residual LUT for `rawPath` once per open (the
  /// A2 artifacts the chain's curve/LUT passes reapply every tick). No-op after
  /// the first call per open, or when `model.profile != .auto`.
  public func fitAutoProfileIfNeeded(
    rawPath: String, model: AdjustmentModel, quality: PipelineRenderer.Quality
  ) async {
    guard let s = session else { return }
    if model.profile == .auto && !autoProfileFitDone {
      autoProfileFitDone = true
      await s.fitAutoProfile(rawPath: rawPath, quality: quality)
    }
  }

  /// Present `model` to the registered layer via the GPU chain. SUPERSEDES
  /// any present still queued behind the actor: flips the prior present's
  /// cancel flag (the FFI drops a superseded present at its entry) and mints a
  /// fresh flag for this one, so the last present issued wins. A no-op when
  /// there is no session or no layer yet (the canvas keeps its prior frame).
  /// Surfaces a real GPU/present error through `onError` (device logs aren't
  /// capturable — the in-app HUD is the only on-device surface). Returns true
  /// only for a current frame submitted by this session; cancelled/skipped
  /// requests must not advance EditSession's preview or histogram generation.
  @discardableResult
  public func present(
    model: AdjustmentModel,
    asShotCCT: Double? = nil,
    asShotTint: Double? = nil,
    wbFrame: WbSliderFrame? = nil,
    onError: (Error) -> Void
  ) async -> Bool {
    guard !Task.isCancelled else { return false }
    guard let s = session else {
      gpuDriverLog.notice("GPU-TRACE driver.present skipped: no session")
      return false
    }
    guard let layer = layer else {
      gpuDriverLog.notice("GPU-TRACE driver.present skipped: no layer")
      return false
    }
    // Read ONCE and hand the SAME value to both the layer tag and the
    // params below — see `retagLayerIfNeeded`'s doc for why two
    // independent `.current` reads would race.
    let revision = sessionRevision
    let colorSpace = CanvasColorSpace.current
    retagLayerIfNeeded(layer, to: colorSpace)
    gpuDriverLog.notice(
      "GPU-TRACE driver.present begin drawableSize=\(Int(layer.drawableSize.width))x\(Int(layer.drawableSize.height))"
    )
    // drawableSize divergence check (#1769): the Rust side is
    // `drawableSize`'s single writer (`surface.configure`), so when this
    // present would hit the no-configure fast path (same generation, same
    // dims as the last successful present) the layer MUST still report
    // those dims. A mismatch means something outside wgpu re-derived the
    // drawable pool (a CoreAnimation scale/bounds re-derivation) — bump the
    // generation so the Rust side tears down + reconfigures + settles with
    // the double-present instead of landing one present on an invalidated
    // pool.
    if let key = lastPresentedKey, let dims = sessionDims,
      key.generation == surfaceGeneration,
      key.width == dims.width, key.height == dims.height,
      layer.drawableSize != CGSize(width: CGFloat(dims.width), height: CGFloat(dims.height))
    {
      surfaceGeneration &+= 1
      gpuDriverLog.notice(
        "GPU-TRACE drawableSize diverged (\(Int(layer.drawableSize.width))x\(Int(layer.drawableSize.height)) vs \(dims.width)x\(dims.height)) — bumped surface generation to \(self.surfaceGeneration)"
      )
    }
    let submittedSurfaceGeneration = surfaceGeneration
    let interval = gpuDriverSignposter.beginInterval(
      "GpuPresentRequest", id: gpuDriverSignposter.makeSignpostID())
    defer { gpuDriverSignposter.endInterval("GpuPresentRequest", interval) }
    inFlightCancel?.requestCancel()
    let cancel = CancelFlag()
    inFlightCancel = cancel
    do {
      let elapsedMs = try await withTaskCancellationHandler {
        try await s.present(
          model: model, layer: layer, cancel: cancel,
          asShotCCT: asShotCCT, asShotTint: asShotTint,
          inputShape: self.inputShape,
          surfaceGeneration: submittedSurfaceGeneration,
          wbFrame: wbFrame,
          targetColorSpace: colorSpace
        )
      } onCancel: {
        cancel.requestCancel()
      }
      withExtendedLifetime(cancel) {}
      guard let elapsedMs, !Task.isCancelled, revision == sessionRevision,
        submittedSurfaceGeneration == surfaceGeneration, layer === self.layer
      else {
        gpuDriverLog.debug("GPU present did not publish a current frame")
        return false
      }
      gpuDriverLog.notice("GPU-TRACE driver.present OK \(elapsedMs)ms")
      if let dims = sessionDims {
        lastPresentedKey = (submittedSurfaceGeneration, dims.width, dims.height)
      }
      if GpuHudFlag.isEnabled { frameStats.record(elapsedMs) }
      return true
    } catch is CancellationError {
      return false
    } catch let e as GpuLiveError {
      guard !Task.isCancelled, revision == sessionRevision,
        submittedSurfaceGeneration == surfaceGeneration, layer === self.layer
      else { return false }
      gpuDriverLog.notice("GPU-TRACE driver.present THREW: \(e.message, privacy: .public)")
      onError(e)
      return false
    } catch {
      guard !Task.isCancelled, revision == sessionRevision,
        submittedSurfaceGeneration == surfaceGeneration, layer === self.layer
      else { return false }
      gpuDriverLog.notice(
        "GPU-TRACE driver.present THREW: \(error.localizedDescription, privacy: .public)")
      onError(error)
      return false
    }
  }

  /// Render the CURRENT session's frame to a `width·height·3` u8 RGB CPU buffer —
  /// the EXACT bytes `present` puts on screen (same chain + dither; the live
  /// params hardcode `target_primaries = 0`, so sRGB-primary gamma-encoded).
  /// For editor-exit preview/thumbnail persistence; NOT for per-tick
  /// use — it re-runs the chain WITH a CPU readback, the very cost `present`
  /// avoids. Returns `nil` when no session is open or the render was cancelled
  /// (the caller then simply leaves the cache unpopulated).
  public func renderCurrentFrameBytes(
    model: AdjustmentModel,
    asShotCCT: Double? = nil,
    asShotTint: Double? = nil,
    wbFrame: WbSliderFrame? = nil
  ) async -> (bytes: [UInt8], width: Int, height: Int)? {
    guard let s = session, let dims = sessionDims else { return nil }
    guard !Task.isCancelled else { return nil }
    let revision = sessionRevision
    do {
      guard
        let bytes = try await s.renderToBuffer(
          model: model,
          asShotCCT: asShotCCT,
          asShotTint: asShotTint,
          inputShape: inputShape,
          wbFrame: wbFrame
        )
      else { return nil }
      guard !Task.isCancelled, revision == sessionRevision else { return nil }
      return (bytes, dims.width, dims.height)
    } catch {
      gpuDriverLog.error(
        "renderCurrentFrameBytes failed: \(error.localizedDescription, privacy: .public) — preview cache not populated"
      )
      return nil
    }
  }

  /// Reject a readback if a crop/resize replaced its session while awaiting it.
  public func histogramForCurrentFrame() async throws -> CloudHistogram? {
    try Task.checkCancellation()
    guard let session else { return nil }
    let revision = sessionRevision
    let result = try await session.displayedHistogram()
    try Task.checkCancellation()
    guard revision == sessionRevision else { throw CancellationError() }
    return result
  }

  /// Whether a session is open (so the EditSession knows the GPU path is live).
  public var hasSession: Bool { session != nil }

  /// Whether a canvas layer has been registered (the host view has laid out).
  /// Until then the GPU path has nothing to present into and the caller keeps
  /// publishing a CIImage via the CPU path so the canvas isn't blank.
  public var hasLayer: Bool { layer != nil }

  /// Pure reuse decision (#2039, #2049) — factored out of `isOpen` so it's
  /// testable with no Metal / session involved. `openDims`/`uploadedIdentity`
  /// are `nil` when no session is open (always "not reusable" then).
  ///
  /// Reuse requires BOTH:
  ///   * coverage — the open session's dims are ≥ the request on both axes.
  ///     `presentViaGpuLive` only ever requests the viewport size (fast) or
  ///     the ≤2× refine size, so reusing a bigger session for a smaller
  ///     request bounds the supersampling cost to that same ceiling — the
  ///     presented buffer supersamples down through the `CAMetalLayer`,
  ///     which is visually fine.
  ///   * identity — the uploaded pixels came from the SAME decode
  ///     generation and crop as the request. See `GpuUploadIdentity`.
  nonisolated static func shouldReuseSession(
    openDims: (width: Int, height: Int)?,
    uploadedIdentity: GpuUploadIdentity?,
    requestWidth: Int,
    requestHeight: Int,
    requestIdentity: GpuUploadIdentity
  ) -> Bool {
    guard let dims = openDims else { return false }
    return dims.width >= requestWidth
      && dims.height >= requestHeight
      && uploadedIdentity == requestIdentity
  }

  /// Whether the current session both COVERS `width × height` and was
  /// uploaded from `identity` — the upload-once-and-reuse guard (#2039,
  /// #2049). `presentViaGpuLive` re-reads-back + re-uploads only when this
  /// is `false`.
  public func isOpen(coveringWidth width: Int, height: Int, identity: GpuUploadIdentity) -> Bool {
    guard session != nil else { return false }
    return Self.shouldReuseSession(
      openDims: sessionDims, uploadedIdentity: uploadedIdentity,
      requestWidth: width, requestHeight: height, requestIdentity: identity
    )
  }

  /// The current session dims, if open.
  public var currentDims: (width: Int, height: Int)? { sessionDims }

  /// Memory-pressure eviction also invalidates replacements waiting on close,
  /// so a stale render cannot reopen an editor that has just been evicted.
  public func closeSession() async {
    sessionRevision &+= 1
    let revision = sessionRevision
    beginSessionTeardown()
    if let teardown = sessionTeardown { await teardown.value }
    if revision == sessionRevision { sessionTeardown = nil }
  }
}
