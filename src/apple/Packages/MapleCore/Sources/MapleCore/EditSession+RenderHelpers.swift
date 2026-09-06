// EditSession+RenderHelpers.swift — Render helpers extracted to satisfy file budget.
//

import CoreImage
import Foundation

@MainActor
extension EditSession {
  /// Schedule a fast-phase render WITHOUT going through `openAssetPipelineAsync`.
  /// Reuses the decoded buffer cache; just kicks `decodeAndRender(.fast)` so
  /// the next `presentViaGpuLive` runs against the current model.
  ///
  /// Surfaced for `GpuLiveCanvasController.layoutAndPresent` to call after
  /// `driver.register(layer:)` fires: in a cold-open with no `nativeImageSize`
  /// seed (cloud-loaded asset, sourceless PhotoKit, etc.), the canvas can't
  /// mount until the decode publishes a buffer extent. The cold-open's first
  /// render then publishes via the CPU path (because `hasLayer` was false at
  /// that moment) — `ensureRenderStarted`'s `renderedPreview == nil` guard
  /// then short-circuits any follow-up render, so the chip stays on CPU until
  /// the user drags a slider. This method is the canvas controller's "I just
  /// registered, please re-render" hook: cheap (no decode), bypasses the
  /// preview-set guard. (#1362 follow-up — caught on iPad with self-hosted
  /// cloud assets where the bytes download adds seconds to canvas-mount.)
  ///
  /// #2064: does NOT cancel a render that's already in flight. A render
  /// that started before the layer registered still re-reads
  /// `driver.hasLayer` live at present time (`presentViaGpuLive`), so in
  /// the common case it picks up the layer we just registered on its own
  /// — cancelling it here would only discard that work and immediately
  /// redo an identical pass. Instead, wait for it to settle and re-check:
  /// if the GPU still hasn't presented (the narrow race where that
  /// render's own `hasLayer` check ran BEFORE this registration, and it
  /// already committed to the CPU path), fall through to the original
  /// unconditional kick — the mount is never silently dropped, only
  /// deferred behind whatever render was already running.
  public func kickRenderAfterGpuCanvasMount() {
    guard gpuLiveDriver?.hasLayer == true, !gpuFramePresented else { return }
    let actor = renderActor
    Task { @MainActor [weak self] in
      guard let self else { return }
      await actor.awaitCurrentRenderIfInFlight()
      guard self.gpuLiveDriver?.hasLayer == true, !self.gpuFramePresented else { return }
      self._scheduleRender(phase: .fast)
    }
  }

  /// Re-present the current model after the scene returns to `.active`
  /// (#1769, iOS). Metal discards presents issued while the app is
  /// backgrounded, and CoreAnimation may hand back a stale/partial drawable
  /// on reactivation — nothing else in the pipeline repaints when the MODEL
  /// hasn't changed, so a canvas backgrounded mid-present could stay torn
  /// indefinitely. One cheap fast-phase pass (cached decode → GPU present)
  /// puts a whole frame back on glass. No-op when the GPU path isn't active
  /// (the CPU `renderedPreview` is a plain SwiftUI image — reactivation
  /// re-composites it for free).
  public func representOnForeground() {
    guard GpuLiveFlag.isEnabled,
      gpuLiveDriver?.hasLayer == true,
      gpuFramePresented,
      !gpuPresentFailed
    else { return }
    _scheduleRender(phase: .fast)
  }

  /// Force a full-resolution render immediately (useful before export).
  public func renderFull() async {
    renderRequested = true
    // Bypass the scheduler — caller wants the work to land before
    // returning. Take a fresh generation so the gen-check inside
    // `decodeAndRender` lines up against the live counter.
    let gen = await renderActor.currentGeneration()
    await decodeAndRender(targetSize: nil, phase: .refine, gen: gen)
  }

  /// Bake the current model against a fresh full-quality decode for export.
  public func renderForExport() async throws -> CIImage {
    let exportModel = model
    // Film look (epic #2683, Task 10): a RAW asset with a resolved look
    // routes through `maple_render_file_with_film` instead of the plain
    // CIImage graph below — see `EditSession+FilmExport.swift` for why.
    // Returns `nil` (falls through) for every other case: no look,
    // non-RAW, sourceless, or an FFI render failure.
    if let filmExport = try await renderExportWithFilmLook() {
      return filmExport
    }
    // Resolve the look BEFORE the render (#3190 review follow-up): a
    // non-RAW export with an active look must pin `renderForExport`'s
    // encode to sRGB, matching the interactive CPU fallback's rule
    // (`EditSession+Render.swift`) — the `FilmLookCube` lattice is
    // baked in sRGB, so handing it P3-gamma bytes (canvas set to
    // Display P3) would misinterpret them as sRGB-gamma. `filmLattice`
    // is resolved once here and reused for both the pin decision and
    // the actual `apply` below.
    let filmLattice = filmLutStore.lattice(for: exportModel.filmLook)
    let filmActive = filmLattice != nil && exportModel.filmStrength > 0
    // #1781: decode-bake anchor with a present frame; the export
    // decode's own frame export rides processSceneLinear(wbFrame:).
    let image = try await renderActor.renderForExport(
      asset: asset, model: exportModel, asShot: wbDeltaAnchor,
      targetPrimariesOverride: filmActive ? .srgb : nil
    )
    // Non-RAW film-look export (#2713): the CIImage-graph path above has
    // no FFI film-look stage (`maple_render_file_with_film` is RAW-only
    // — see `EditSession+FilmExport.swift`'s file header), so a JPEG/
    // HEIF export with a look previously came out unlooked even though
    // the live canvas shows it. `renderActor.renderForExport`'s output
    // is already display-encoded (sRGB when film is active, per the pin
    // above) — the same domain the interactive canvas's CPU fallback
    // composites `FilmLookCube` onto (`EditSession+Render.swift`) — so
    // apply it here the same way. Gated on `!asset.isRaw`: the RAW path
    // above is either bit-exact (a resolved look) or intentionally
    // look-less (no look), and this must not change either of those
    // outcomes. `FilmLookCube.apply` is itself a no-op when
    // `model.filmLook` has no resolvable lattice, so this is safe to
    // call unconditionally for every non-RAW export.
    let developed =
      asset.isRaw
      ? image
      : FilmLookCube.apply(
        to: image, lattice: filmLattice, strengthPct: exportModel.filmStrength)
    // Scene-linear renders return the full oriented frame. The live canvas
    // crops separately; export must do the same, even while the crop tool
    // is armed. The full RAW film path above already crops in Rust (#3357).
    return CropImageStage.apply(
      exportModel.crop, to: developed, nativeSize: developed.extent.size)
  }
}
