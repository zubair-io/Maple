// EditSession+DeepZoom.swift — visible-region plumbing for deep zoom
// (Plan 3 / Ticket 06 M4).
//
// Split from EditSession.swift (issue #120). Owns the visible-region
// API the native-detail path consults when `pixelScale >= 1.0`
// (`updateTileVisibleRegion`, called by `CanvasZoomController`).
// The 512²-grid `TileManager` compositor that used to live behind
// `EditSession.deepZoomEnabled` was retired in #3288 — native detail
// (one viewport-sized patch, `refineNativeDetail`) is the 100% path —
// so this file no longer owns any tile-manager lifecycle.
//
// Pure-math helper `computeVisibleSourceRect` stays static + nonisolated
// so off-main callers (`CanvasZoomController` at construction time, the
// unit-test suite) can use it without an actor hop.

import CoreImage
import Foundation
import RawPipeline

@MainActor
extension EditSession {
  // MARK: - Public deep-zoom API

  /// `CanvasZoomController` calls this from the magnification gesture, the
  /// ⌘1/⌘=/⌘- toolbar shortcuts, and (on macOS) the Cmd+scroll
  /// handler. Updates the visible source-pixel rect for native
  /// detail and the live `pixelScale`. When `zoom` changes
  /// meaningfully (epsilon = 0.01) we re-schedule a refine so the
  /// native-detail branch in `_scheduleRefine` retargets the new
  /// visible region. Pure pan with the same zoom triggers a refine
  /// reschedule too — the native-detail patch has to retarget the
  /// new visible region (unless the containment fast path below
  /// finds it already covered).
  public func updateTileVisibleRegion(viewport: CGRect, zoom: CGFloat) {
    // The shared rule (`NativeDetailLOD.visibleRegionChange`, #5714)
    // keeps the published patch across a small pure pan that stays
    // inside it (#2063): the overlay is positioned in SOURCE coordinates
    // inside the same pan/zoom-transformed frame as the base preview, so
    // it keeps tracking the pan with no clear (which would drop the
    // sharp overlay to the blurry base for the 150 ms debounce) and no
    // fresh develop.
    let change = NativeDetailLOD.visibleRegionChange(
      from: viewportSourceRect, to: viewport,
      previousZoom: pixelScale, zoom: zoom,
      publishedPatch: publishedNativeDetailPatch,
      imageSize: nativeImageSize
    )
    if change.clears_patch != 0 {
      clearNativeDetailPreview()
    }
    viewportSourceRect = viewport
    pixelScale = zoom  // didSet on pixelScale will reschedule when changed
    // A pure pan off the patch does not fire pixelScale.didSet.
    if change.schedules_refine != 0 {
      _scheduleRefine()
    }
  }

  /// The published native-detail patch's source rect, nil when none is shown.
  var publishedNativeDetailPatch: CGRect? {
    nativeDetailPreview == nil ? nil : nativeDetailSourceRect
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
  /// (the native-detail branch in `_scheduleRefine` reads `.isEmpty`
  /// to decide whether a visible patch can render). `CanvasMath`
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
    // rect. Tests + the native-detail branch depend on `.zero` here.
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
