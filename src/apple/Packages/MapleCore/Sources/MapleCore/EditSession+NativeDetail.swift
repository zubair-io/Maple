// EditSession+NativeDetail.swift — viewport-bounded 1:1 RAW refinement.

import CoreImage
import Foundation

@MainActor
extension EditSession {
  /// Drop the native-detail overlay and invalidate any result currently in
  /// flight. Pure pan/zoom refines intentionally do not bump the main render
  /// generation, so this independent token is the stale-work guard.
  func clearNativeDetailPreview() {
    if let activityID = nativeDetailInFlightID {
      nativeDetailInFlightID = nil
      endRenderActivity(activityID)
    }
    nativeDetailRequestID &+= 1
    nativeDetailPreview = nil
    nativeDetailSourceRect = .zero
  }

  /// Develop and publish a full-quality 1:1 patch for the current visible
  /// source rectangle. Returns false when the RAW tile entry rejects the
  /// model, allowing the bounded whole-image refine fallback to run.
  func refineNativeDetail(gen: UInt64) async -> Bool {
    let asset = self.asset
    let assetID = asset.id
    let viewportDetailRect = NativeDetailLOD.detailRect(
      visibleRect: viewportSourceRect,
      imageSize: nativeImageSize
    )
    guard !viewportDetailRect.isEmpty else { return false }

    // Already-covered fast path (#2063): `updateTileVisibleRegion`'s
    // containment check keeps the overlay across a small pan without
    // ever calling in here, but a refine can still reach this point
    // from other `_scheduleRefine` callers (a tile-completion poke, a
    // coalesced reschedule) after the viewport already settled inside
    // the published patch. If so there is nothing new to develop —
    // bail out before opening any RAW handle.
    if nativeDetailPreview != nil,
      nativeDetailSourceRect.contains(viewportDetailRect)
    {
      return true
    }

    // Grow the published patch beyond the immediate viewport
    // (`NativeDetailLOD.panMargin`) so a subsequent small pan lands
    // inside it and hits the fast path above instead of paying this
    // develop again. `decodeRect` adds the chain's reach (at least
    // `filterHalo`) on top for filter-stencil context only.
    // `renderModel`, not `model`: a panel-disabled layer must stay inert at
    // 100% as it does at fit. The windowed chain below evaluates every mask
    // in full-frame coordinates itself (#5169), so the stack is passed
    // unmapped. (`NativeDetailRenderer` strips it from the tile develop, so
    // the chain is the one place it is applied.)
    let m = renderModel
    // Dehaze measures haze over the whole frame and perspective warps it,
    // so neither has a patch form: the bounded whole-image refine renders
    // them, as on every other platform. The windowed chain refuses dehaze
    // too; this only skips the tile develop that refusal would waste.
    guard abs(m.dehaze) < 1e-3,
      !m.localAdjustments.contains(where: { abs($0.adjustments.dehaze ?? 0) >= 1e-3 }),
      m.perspective.isIdentity
    else { return false }
    let publishedPatchRect = NativeDetailLOD.patchRect(
      visibleRect: viewportSourceRect,
      imageSize: nativeImageSize
    )
    // The halo covers the chain's full reach, including the S/H mask whose
    // blur scales with the frame's long edge (#5169).
    let decodeRect = NativeDetailLOD.decodeRect(
      detailRect: publishedPatchRect,
      imageSize: nativeImageSize,
      halo: CGFloat(
        PipelineRenderer.sceneLinearChainWindowReach(model: m, fullSize: nativeImageSize))
    )
    guard !publishedPatchRect.isEmpty, !decodeRect.isEmpty else { return false }

    nativeDetailRequestID &+= 1
    let requestID = nativeDetailRequestID
    let activityID = beginRenderActivity()
    nativeDetailInFlightID = activityID
    // The rendering flag must flip in the same MainActor slice as the
    // in-flight token, BEFORE the first suspension: an invalidation that
    // lands mid-await clears `isRendering` and nils the token, and this
    // request's defer then must not re-assert either one.
    renderPhase = .refine
    defer {
      if nativeDetailInFlightID == activityID {
        nativeDetailInFlightID = nil
      }
      endRenderActivity(activityID)
    }
    let pipeline = self.pipeline
    let renderer = nativeDetailRenderer
    // Resolved on MainActor (matching `filmLutStore`'s other callers,
    // `syncFilmLutForPresent`/`renderExportWithFilmLook`) — its cache
    // is a plain, unsynchronized class, so every call must stay on
    // MainActor rather than racing from the detached render below.
    // `Optional<(data:[Float], size:Int, key:UInt32)>` is Sendable, so
    // it captures cleanly into the detached closure (#2683 / #2713).
    let filmLattice = filmLutStore.lattice(for: m.filmLook)
    let snapshot = await renderActor.snapshot(forAsset: asset, liveModel: decodeKey(m))
    guard requestID == nativeDetailRequestID, !Task.isCancelled else { return true }
    adoptDecodedWbFrame(snapshot.wbFrame)
    // #1976: the live WB delta is applied ONCE, by the windowed chain
    // below, anchored at the buffer's actual as-shot bake
    // (`wbDeltaAnchor`). The tile render itself takes NO anchor — see
    // `NativeDetailRenderer.render` for why the old per-tile anchor
    // was a no-op only by accidental cancellation and turned into a
    // warm cast the moment the chain anchor was corrected.
    let asShot = wbDeltaAnchor

    let signpostID = editSessionSignposter.makeSignpostID()
    let signpostState = editSessionSignposter.beginInterval(
      "native-detail", id: signpostID
    )
    defer { editSessionSignposter.endInterval("native-detail", signpostState) }

    editSessionLogger.debug(
      "native detail gen=\(gen) request=\(requestID) rect=\(publishedPatchRect.origin.x, format: .fixed(precision: 0)),\(publishedPatchRect.origin.y, format: .fixed(precision: 0)) \(publishedPatchRect.width, format: .fixed(precision: 0))x\(publishedPatchRect.height, format: .fixed(precision: 0))"
    )

    do {
      let decoded = try await renderer.render(
        asset: asset,
        sourceRect: decodeRect,
        model: m,
        // #1167/#2070: the gain of the buffer currently on screen —
        // the tile must reproduce the SAME AE anchor the full-image
        // (or sized) decode this snapshot came from already applied.
        aeGain: snapshot.aeGain
      )
      guard requestID == nativeDetailRequestID, !Task.isCancelled else {
        return true
      }

      // Use the same preview-quality Auto Profile tail as the base
      // canvas; only demosaic/source sampling is native-resolution.
      let profileLUT: CIFilter? = await {
        guard m.profile == .auto, let url = asset.primaryURL else { return nil }
        return await AutoProfileLUT.shared.filter(
          forRawAt: url,
          profile: m.profile,
          quality: .preview
        )
      }()
      guard requestID == nativeDetailRequestID, !Task.isCancelled else { return true }
      let localDetailRect = NativeDetailLOD.localCoreImageRect(
        detailRect: publishedPatchRect,
        decodeRect: decodeRect
      )
      // #3190 review follow-up: `FilmLookCube` assumes an sRGB-encoded
      // input (same as the Auto Profile cube below) — when the film
      // look is active, pin the chain's encode to sRGB
      // regardless of the canvas setting so the cube isn't fed
      // P3-gamma bytes it would misinterpret as sRGB-gamma. Mirrors
      // `profileLUT != nil ? .srgb : ...` immediately below.
      let filmActive = filmLattice != nil && m.filmStrength > 0
      let targetPrimaries: CanvasColorSpace =
        (profileLUT != nil || filmActive) ? .srgb : CanvasColorSpace.current
      let fullSize = nativeImageSize
      let materialised = try await Task.detached(priority: .userInitiated) {
        () throws -> CIImage? in
        // The patch's place in the frame rides along, so the S/H mask,
        // masks, vignette and grain match the full-frame render (#5169).
        let processed = try pipeline.processSceneLinearWindow(
          decoded: decoded,
          model: m,
          origin: decodeRect.origin,
          fullSize: fullSize,
          asShot: asShot,
          profileLUT: profileLUT,
          noiseProfile: snapshot.noiseProfile,
          iso: snapshot.iso,
          wbFrame: snapshot.wbFrame,
          whitesAnchorEv: snapshot.whitesAnchorEv,
          targetPrimaries: targetPrimaries
        )
        // Film look (#2683): the windowed chain's output is
        // already the final gamma-encoded image in `targetPrimaries`
        // (pinned to sRGB above whenever film is active) — the same
        // domain the `.mlut` lattice is baked in — bake the cube
        // here rather than in the FFI chain (#2713). Closes the
        // "film vanishes at 100% zoom" gap: this is the CPU
        // native-detail path that renders every interactive
        // pixel-for-pixel refine.
        let filmed = FilmLookCube.apply(
          to: processed,
          lattice: filmLattice,
          strengthPct: m.filmStrength
        )
        let cropped = filmed.cropped(to: localDetailRect)
        // Tag must match what the windowed chain actually encoded
        // (`targetPrimaries` above) — see `materializeRegion`'s doc
        // comment (jules review on #3239: this used to be hardcoded
        // to sRGB regardless of the real tag).
        let colorSpace =
          targetPrimaries == .displayP3
          ? ImageEditPipeline.displayEncodedColorSpaceP3
          : ImageEditPipeline.displayEncodedColorSpace
        guard
          let cg = pipeline.materializeRegion(
            cropped,
            rect: localDetailRect,
            colorSpace: colorSpace
          )
        else { return nil }
        return CIImage(cgImage: cg)
      }.value

      let live = await renderActor.currentGeneration()
      guard requestID == nativeDetailRequestID,
        gen == live,
        !Task.isCancelled,
        self.asset.id == assetID,
        NativeDetailLOD.shouldRender(
          pixelScale: pixelScale,
          visibleRect: viewportSourceRect,
          imageSize: nativeImageSize
        )
      else { return true }
      guard let materialised else {
        editSessionLogger.warning(
          "native detail materialise failed; using bounded refine fallback"
        )
        return false
      }

      nativeDetailPreview = materialised
      nativeDetailSourceRect = publishedPatchRect
      renderError = nil
      return true
    } catch is CancellationError {
      return true
    } catch {
      guard requestID == nativeDetailRequestID else { return true }
      editSessionLogger.warning(
        "native detail unavailable; using bounded refine fallback: \(error.localizedDescription, privacy: .public)"
      )
      return false
    }
  }
}
