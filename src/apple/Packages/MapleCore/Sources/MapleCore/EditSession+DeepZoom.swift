// EditSession+DeepZoom.swift — tile-based deep-zoom (Plan 3 / Ticket 06 M4).
//
// Split from EditSession.swift (issue #120). Owns the visible-region
// plumbing and the tile-manager lifecycle the refine path consults when
// `pixelScale >= 1.0` and `EditSession.deepZoomEnabled` is on.
//
// Pure-math helper `computeVisibleSourceRect` stays static + nonisolated
// so off-main callers (`CanvasZoomController` at construction time, the
// unit-test suite) can use it without an actor hop.

import Foundation
import CoreImage

@MainActor
extension EditSession {
    // MARK: - Public deep-zoom API

    /// `CanvasZoomController` calls this from the magnification gesture, the
    /// ⌘1/⌘=/⌘- toolbar shortcuts, and (on macOS) the Cmd+scroll
    /// handler. Updates the visible source-pixel rect for the tile
    /// manager and the live `pixelScale`. When `zoom` changes
    /// meaningfully (epsilon = 0.01) we re-schedule a refine so the
    /// deep-zoom branch in `_scheduleRefine` re-routes through the
    /// tile manager. Pure pan with the same zoom triggers a refine
    /// reschedule too — the tile composite has to retarget the new
    /// visible region.
    public func updateTileVisibleRegion(viewport: CGRect, zoom: CGFloat) {
        let prevRect = viewportSourceRect
        let prevZoom = pixelScale
        let rectChanged = !prevRect.equalTo(viewport)
        // Pure pan does not touch pixelScale, so invalidate the old native
        // detail patch here before its source region moves off-screen.
        if rectChanged { clearNativeDetailPreview() }
        viewportSourceRect = viewport
        pixelScale = zoom  // didSet on pixelScale will reschedule when changed
        // If zoom didn't change but the viewport rect did (pure pan),
        // pixelScale.didSet won't fire — kick a refine here. Use a
        // small tolerance so a sub-pixel jitter doesn't trigger a
        // reschedule storm during a pinch.
        if abs(zoom - prevZoom) <= 0.01, rectChanged {
            _scheduleRefine()
        }
    }

    // MARK: - Refine path

    /// Deep-zoom refine path (Plan 3 Task 8). Lazily spins up the
    /// session's `TileManager`, asks it to composite the visible-tile
    /// set, and republishes the result as `renderedPreview`. The tile
    /// manager fetches missing tiles in the background; this method
    /// returns the composite of currently-cached tiles immediately.
    /// When new tiles land, `tileEventsTask` reschedules a refine so
    /// the composite progressively fills in.
    func refineDeepZoom(gen: UInt64) async {
        let mgr = ensureTileManager()
        // Snapshot inputs that the actor call might race against a
        // pixelScale write. We only republish if the gen counter
        // matches at the end.
        let visible = viewportSourceRect
        let zoom = pixelScale
        let assetRef = self.asset
        do {
            let composite = try await mgr.update(
                asset: assetRef,
                viewportSourceRect: visible,
                zoom: zoom,
                totalSourceSize: nativeImageSize
            )
            let live = await renderActor.currentGeneration()
            guard gen == live, !Task.isCancelled else { return }
            if !composite.extent.isEmpty {
                // Composite the tile-canvas OVER an upscaled version of
                // the existing preview. Tiles cover the visible viewport;
                // the upscaled preview fills everything else (blurry but
                // not black — CGImage from a CIImage with transparent
                // regions over an sRGB workspace fills with black). Read
                // the underlay NOW, post-await: a fast pass may have
                // published a newer full render while the tile fetch was
                // in flight, and compositing over a pre-await capture
                // would clobber it with stale-tone pixels (#1881).
                renderedPreview = compositeWithPreviewUnderlay(
                    composite,
                    underlay: renderedPreview,
                    canvasSize: nativeImageSize
                )
                // Tiles cover the viewport only; everything else is
                // upscaled underlay of unknown vintage. Never persistable.
                previewIsFullRender = false
            }
            renderError = nil
        } catch {
            editSessionLogger.error(
                "refineDeepZoom failed gen=\(gen) error=\(String(describing: error), privacy: .public)"
            )
            renderError = error
        }
    }

    /// Place the tile composite (full-canvas extent, transparent where
    /// no tiles loaded) over an upscaled `underlay` (preview-quality
    /// image) so unloaded regions show preview pixels instead of black.
    /// The output extent equals `canvasSize`.
    ///
    /// Lives here because the deep-zoom path was designed around it; the
    /// visible-region refine in `EditSession+Render.swift` calls it too
    /// for the same "fresh viewport patch over prior preview" behaviour.
    func compositeWithPreviewUnderlay(
        _ composite: CIImage,
        underlay: CIImage?,
        canvasSize: CGSize
    ) -> CIImage {
        let canvasRect = CGRect(origin: .zero, size: canvasSize)
        guard let underlay,
              underlay.extent.width > 0,
              underlay.extent.height > 0,
              canvasSize.width > 0,
              canvasSize.height > 0
        else {
            return composite
        }
        // Scale the underlay to the full canvas. Translate origin to
        // (0, 0) first because some preview-source CIImages carry a
        // non-zero origin (cropped buffers, embedded JPEGs).
        let originNormalized = underlay.transformed(by: CGAffineTransform(
            translationX: -underlay.extent.origin.x,
            y: -underlay.extent.origin.y
        ))
        let sx = canvasSize.width / underlay.extent.width
        let sy = canvasSize.height / underlay.extent.height
        let scaledUnderlay = originNormalized
            .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
            .cropped(to: canvasRect)
        return composite
            .composited(over: scaledUnderlay)
            .cropped(to: canvasRect)
    }

    /// Lazy create the session's `TileManager` and start the
    /// tile-completion subscription. Subsequent calls return the
    /// existing instance. Must be called from the main actor — the
    /// session itself is `@MainActor` so this is implicit.
    func ensureTileManager() -> TileManager {
        if let mgr = tileManager { return mgr }
        let mgr = TileManager(rawCache: RawImageCache.shared)
        tileManager = mgr
        // Subscribe to tile-completion events. Each tile insert pokes
        // the refine scheduler so the deep-zoom composite progressively
        // refines. The subscription task lives until the session
        // deinits or the asset switches.
        tileEventsTask?.cancel()
        tileEventsTask = Task { [weak self, weak mgr] in
            guard let mgr else { return }
            // `events()` is actor-isolated; the await hops onto the
            // tile manager's actor to construct the stream. Iterating
            // the stream, however, is just AsyncStream.Iterator —
            // doesn't require staying on the manager's actor.
            let stream = await mgr.events()
            for await _ in stream {
                guard let self else { return }
                if Task.isCancelled { return }
                // Coalesce repaints. _scheduleRefine has its own 250 ms
                // debounce, so a flurry of tile inserts collapses into
                // a single re-composite pass. Hop onto the main actor
                // to call into the session.
                await MainActor.run { self._scheduleRefine() }
            }
        }
        return mgr
    }
}

// MARK: - Pure-math helper (nonisolated static)

extension EditSession {
    /// Compute the visible region in oriented full-image source-pixel
    /// coords from the on-screen viewport (in points), the current
    /// zoom (real-px-per-image-px), the native image extent, and the
    /// current pan offset (in points; positive = image dragged right /
    /// down). `displayScale` is points → real pixels.
    ///
    /// Thin forwarder around `CanvasMath.visibleSourceRect`; kept on
    /// `EditSession` so existing call sites (`CanvasZoomController`,
    /// `EditSessionDeepZoomTests`) don't have to thread the value type
    /// in just to read this one rect. The actual math lives in
    /// `CanvasMath` (Ticket 10 item I).
    ///
    /// Important contract difference vs. `CanvasMath.visibleSourceRect`:
    /// here `zoom == 0` is treated as "disabled" and returns `.zero`
    /// (the deep-zoom branch in `_scheduleRefine` reads `.isEmpty` to
    /// decide whether to route through the tile manager). `CanvasMath`
    /// treats `pixelScale == 0` as "fit" and resolves it. Callers that
    /// pass a literal zero through this helper (e.g. fit-mode toolbar
    /// reset) want the disabled semantics; the View already
    /// pre-resolves `pixelScale` to a non-zero value via
    /// `effectivePixelScale` before calling here.
    ///
    /// `nonisolated` so callers (`CanvasZoomController` at construction time,
    /// `MapleCoreTests` off-main) can invoke it without an actor hop.
    nonisolated public static func computeVisibleSourceRect(
        viewport: CGSize,
        zoom: CGFloat,
        imageSize: CGSize?,
        panOffset: CGSize,
        displayScale: CGFloat
    ) -> CGRect {
        // Preserve the disabled-on-zero contract — `CanvasMath`'s
        // `visibleSourceRect` would resolve 0 → fit and return a real
        // rect. Tests + deep-zoom branch depend on `.zero` here.
        guard zoom > 0 else { return .zero }
        let viewportPx = CGSize(
            width: viewport.width * displayScale,
            height: viewport.height * displayScale
        )
        let canvas = CanvasMath(
            viewportPx: viewportPx,
            nativeImageSize: imageSize ?? .zero,
            pixelScale: zoom,
            panOffset: panOffset,
            displayScale: displayScale
        )
        return canvas.visibleSourceRect
    }
}
