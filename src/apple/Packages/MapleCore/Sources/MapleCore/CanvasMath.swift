// CanvasMath.swift — DRY value type for canvas fit/zoom/framing math.
//
// Pre-Ticket 10 item I, fit-pixel-scale, display-frame, refine-target, and
// visible-source-rect math was duplicated across `FullImageView` (lines
// 60–148, 226–247) and `EditSession` (lines 344–367, 441–467). Each
// consumer recomputed the same arithmetic with subtly different guards
// (e.g. native-size sentinel handling, displayScale defaults), and the
// `View @State pixelScale` (`0` = fit) vs. `EditSession.pixelScale`
// (resolved value) duplication meant the two never agreed in fit mode.
//
// Centralising the math here makes the resolved fit-pixel-scale, the
// display frame in points, the fast / refine target sizes, and the
// visible-source rect single-source-of-truth. Both consumers build a
// `CanvasMath` snapshot from the same inputs and read derived values
// off the same instance — no per-call-site recomputation.
//
// Pure value type: `Sendable`, `Equatable`, no actor isolation. Safe to
// pass across actor boundaries (Rust FFI prep, tile manager, MainActor
// view body) without copying state piecemeal.
//
// Conventions:
//   • `viewportPx` is in REAL screen pixels (not points). Callers convert
//     points → pixels by multiplying by `displayScale`.
//   • `nativeImageSize` is in oriented full-image source pixels. `.zero`
//     means the metadata seed hasn't fired yet — see `imageExtent` for
//     how derived properties handle that case.
//   • `pixelScale` follows the same convention as today's
//     `EditSession.pixelScale` / `CanvasZoomModel.pixelScale`:
//       – 0   = fit-to-viewport (resolved by `effectivePixelScale`)
//       – 1.0 = pixel-perfect (one image px = one real screen px)
//       – >1  = zoomed in beyond native
//   • `panOffset` is in POINTS, positive = image dragged right/down,
//     mirroring SwiftUI's `DragGesture.translation` convention.

import Foundation
import CoreGraphics

public struct CanvasMath: Sendable, Equatable {
    // MARK: - Inputs

    /// Viewport size in real screen pixels (points × displayScale).
    public let viewportPx: CGSize
    /// Image native pixel size in oriented source pixels. `.zero` until
    /// the metadata-seed completes — `imageExtent` returns nil in that
    /// case so consumers can fall back to a placeholder branch instead
    /// of anchoring zoom math against a preview-resolution baseline.
    public let nativeImageSize: CGSize
    /// User-intent pixel scale: 0 = fit, 1 = pixel-perfect, >1 = zoomed.
    /// Use `effectivePixelScale` for the resolved value.
    public let pixelScale: CGFloat
    /// Pan offset in points. Positive = image dragged right/down.
    public let panOffset: CGSize
    /// Points → real-pixels factor (UIScreen.scale, NSScreen.backingScaleFactor).
    /// Defaults to 1 when callers don't have a meaningful display scale to pass.
    public let displayScale: CGFloat

    public init(
        viewportPx: CGSize,
        nativeImageSize: CGSize,
        pixelScale: CGFloat,
        panOffset: CGSize = .zero,
        displayScale: CGFloat = 1
    ) {
        self.viewportPx = viewportPx
        self.nativeImageSize = nativeImageSize
        self.pixelScale = pixelScale
        self.panOffset = panOffset
        self.displayScale = displayScale
    }

    // MARK: - Derived: image extent

    /// `nativeImageSize` if known, otherwise `nil`. Used by
    /// `EditorView`'s canvas composer to gate the canvas branch — without a
    /// trustworthy native size, fit math anchors to a smaller buffer
    /// (embedded JPEG, sized-FFI output) and "100%" mis-renders.
    public var imageExtent: CGSize? {
        guard nativeImageSize != .zero,
              nativeImageSize.width > 0,
              nativeImageSize.height > 0
        else { return nil }
        return nativeImageSize
    }

    // MARK: - Derived: fit / effective scale

    /// Real-screen-pixels-per-image-pixel for fit-to-viewport.
    /// Returns 1 when the math is degenerate (no image, no viewport).
    public var fitPixelScale: CGFloat {
        guard let imageExtent,
              viewportPx.width > 0, viewportPx.height > 0
        else { return 1 }
        return min(
            viewportPx.width / imageExtent.width,
            viewportPx.height / imageExtent.height
        )
    }

    /// Resolves `pixelScale == 0` (fit) into a concrete value. All
    /// scale-driven math (display frame, refine target, visible rect)
    /// runs through this.
    public var effectivePixelScale: CGFloat {
        pixelScale == 0 ? fitPixelScale : pixelScale
    }

    // MARK: - Derived: SwiftUI display frame in points

    /// Frame size in POINTS for the on-screen canvas. SwiftUI frames
    /// are point-based; we divide by `displayScale` after multiplying
    /// the native size by the resolved scale (real px). Returns nil
    /// when the image extent is unknown.
    public var displayFrameInPoints: CGSize? {
        guard let imageExtent, displayScale > 0 else { return nil }
        let scale = effectivePixelScale
        return CGSize(
            width: imageExtent.width * scale / displayScale,
            height: imageExtent.height * scale / displayScale
        )
    }

    // MARK: - Derived: render targets

    /// Fast-phase target — render at viewport resolution so every filter
    /// intermediate stays small. `nil` when viewport is unset; callers
    /// fall through to the pipeline's built-in 2 MP cap.
    public var fastTargetSize: CGSize? {
        viewportPx == .zero ? nil : viewportPx
    }

    /// Refined-phase target — `nativeImageSize × min(pixelScale, 1.0)`,
    /// floored at `fastTargetSize` so refine is never lower-quality than
    /// the fast pass. Upscaling past native adds no real detail; cap at
    /// 1.0 and let the viewport upscale the native-sized buffer.
    /// Fit mode (pixelScale == 0) resolves to `fast == refine` so the
    /// refine scheduler short-circuits.
    ///
    /// Falls back to an 8× fast-phase estimate when `nativeImageSize`
    /// hasn't been seeded yet (first decode in flight). Once native is
    /// known, the normal branch takes over.
    public var refinedTargetSize: CGSize? {
        guard let fast = fastTargetSize else { return nil }
        // Cap the refine to `headroom×` the viewport long edge. The fit-to-window
        // display never needs more than the viewport (zoom to 100% routes through
        // the fp16 tile path), but an uncapped `native × pixelScale` let the
        // refine approach the full sensor at high zoom (or via the pre-decode
        // fallback below) — a ~1.4 GB f32 buffer that, with the concurrent
        // auto-profile develop, jetsam-killed iOS on a 100 MP RAW (#1637).
        let headroom: CGFloat = 2.0
        let cap = max(fast.width, fast.height) * headroom
        if nativeImageSize == .zero {
            // Pre-decode fallback. Constrain to `headroom×` fast (was 8×) so the
            // first render can't request near-full res before native lands.
            let mult = min(max(1.0, pixelScale), headroom)
            return CGSize(width: fast.width * mult, height: fast.height * mult)
        }
        let scale = min(max(pixelScale, 0), 1.0)
        let w = min(max(nativeImageSize.width * scale, fast.width), cap)
        let h = min(max(nativeImageSize.height * scale, fast.height), cap)
        return CGSize(width: w, height: h)
    }

    // MARK: - Derived: visible source rect (deep zoom)

    /// Visible region in oriented full-image source-pixel coords.
    /// Returns `.zero` when zoom or extent is degenerate.
    ///
    /// Math: at `effectivePixelScale` real-px-per-image-px, a viewport
    /// of `viewportPx.width` real px shows
    /// `viewportPx.width / effectivePixelScale` source pixels
    /// horizontally. The viewport center maps to the image center
    /// adjusted by the current pan; clamp to the image extent so a
    /// viewport that overhangs the image doesn't ask for off-grid tiles.
    public var visibleSourceRect: CGRect {
        let zoom = effectivePixelScale
        guard let imageSize = imageExtent, zoom > 0,
              viewportPx.width > 0, viewportPx.height > 0,
              displayScale > 0
        else { return .zero }
        let visibleSrcW = viewportPx.width / zoom
        let visibleSrcH = viewportPx.height / zoom
        // Pan: panOffset is in points (positive = image dragged right).
        // Convert to source pixels and shift the visible rect's origin
        // opposite the pan (a right drag exposes the image's left side).
        let panSrcX = panOffset.width * displayScale / zoom
        let panSrcY = panOffset.height * displayScale / zoom
        let centerX = imageSize.width / 2 - panSrcX
        let centerY = imageSize.height / 2 - panSrcY
        let unclampedMinX = centerX - visibleSrcW / 2
        let unclampedMinY = centerY - visibleSrcH / 2
        // Clamp: origin >= 0 and origin + size <= imageSize (allowing
        // the visible rect to be smaller than the image when zoomed in,
        // and clamped to the image when the visible region is larger).
        let maxOriginX = max(0, imageSize.width - visibleSrcW)
        let maxOriginY = max(0, imageSize.height - visibleSrcH)
        let minX = max(0, min(unclampedMinX, maxOriginX))
        let minY = max(0, min(unclampedMinY, maxOriginY))
        let w = min(visibleSrcW, imageSize.width)
        let h = min(visibleSrcH, imageSize.height)
        return CGRect(x: minX, y: minY, width: w, height: h)
    }
}
