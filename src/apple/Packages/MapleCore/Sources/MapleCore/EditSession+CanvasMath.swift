// EditSession+CanvasMath.swift — the canvas-state snapshot + derived
// render targets.
//
// Split VERBATIM from EditSession.swift (file-size budget, #2041; same
// pattern as the #2009 Lifecycle split). `canvasMath` is the single
// value-type snapshot (viewport, native size, zoom) every fit/zoom/
// target/visible-rect derivation builds from (Ticket 10 item I);
// `fastTargetSize` / `refinedTargetSize` are the two render-phase
// targets the scheduler reads off it. Pure derivations over stored
// session state — no stored properties live here.

import Foundation
import CoreGraphics

@MainActor
extension EditSession {
    /// Snapshot of the canvas state — viewport, native size, zoom — that
    /// drives every fit/zoom/target/visible-rect derivation. Centralising
    /// the math in `CanvasMath` (Ticket 10 item I) eliminates the dual
    /// `EditSession.pixelScale` (resolved value) vs.
    /// `FullImageView.@State pixelScale` (`0` = fit) source-of-truth
    /// problem — both consumers now build the same value type from the
    /// same inputs. `displayScale` defaults to 1 here because the session
    /// works in real pixels; the View passes its own displayScale when it
    /// needs the points-relative `displayFrameInPoints` accessor.
    public var canvasMath: CanvasMath {
        CanvasMath(
            viewportPx: previewSize,
            nativeImageSize: nativeImageSize,
            pixelScale: pixelScale
        )
    }

    /// Fast-phase target — render at viewport resolution so every filter
    /// intermediate stays small. `nil` falls through to `ImageEditPipeline`'s
    /// built-in 2MP cap.
    var fastTargetSize: CGSize? {
        canvasMath.fastTargetSize
    }

    /// Refined-phase target — `nativeImageSize × min(pixelScale, 1.0)`,
    /// floored at `fastTargetSize` so the refine is never lower-quality
    /// than the fast pass. Upscaling past native adds no real detail, so
    /// we cap at 1.0 and let the viewport upscale the native-sized buffer.
    /// Fit mode (pixelScale == 0) resolves to fast == refine and the
    /// refine scheduler short-circuits.
    ///
    /// Falls back to an 8×-fast estimate if `nativeImageSize` hasn't been
    /// populated yet (first decode is in flight). Once the decode lands,
    /// subsequent refines use the native-anchored path.
    var refinedTargetSize: CGSize? {
        canvasMath.refinedTargetSize
    }
}
