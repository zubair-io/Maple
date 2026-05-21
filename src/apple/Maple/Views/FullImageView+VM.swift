// FullImageView+VM.swift — Pure-function view-model helpers for FullImageView.
//
// Co-located sibling of FullImageView.swift. Holds derivations and formatters
// that take typed inputs and return typed outputs — no SwiftUI, no @State,
// no gestures. The view file calls these helpers and feeds the returned
// values back into its body + gesture closures.
//
// Pattern (issue #192): every SwiftUI view with non-trivial derivation gets
// a sibling `+VM.swift` whose contents are unit-testable in isolation. To
// preserve that guarantee this file MUST NOT `import SwiftUI` — a grep gate
// in CI enforces it. If a helper needs `View` context it doesn't belong here.
//
// `CoreGraphics` is fine — `CGFloat` / `CGSize` are pure value types from
// Foundation's sibling framework and carry no UI dependency. The Web VM
// equivalent would use plain `number` / `{w, h}` records.

import CoreGraphics
import Foundation

// MARK: - FullImageViewVM

/// Namespace for pure FullImageView derivations. A caseless enum keeps the
/// helpers grouped without ever being instantiated. All members are static.
enum FullImageViewVM {

    // MARK: - Zoom indicator (HUD)

    /// Formats the live zoom HUD label — "18%", "100%", "523%". Matches the
    /// reference's `Text("\(percent)%")` formatting exactly: rounds half-up
    /// to the nearest integer, no decimal places. Used by the bottom-leading
    /// indicator on the canvas.
    static func zoomPercentLabel(for effectivePixelScale: CGFloat) -> String {
        "\(zoomPercent(for: effectivePixelScale))%"
    }

    /// VoiceOver / accessibility label for the same indicator — "Zoom 18
    /// percent". Spelled out so screen readers pronounce it cleanly instead
    /// of "eighteen percent sign".
    static func zoomAccessibilityLabel(for effectivePixelScale: CGFloat) -> String {
        "Zoom \(zoomPercent(for: effectivePixelScale)) percent"
    }

    /// Shared integer-rounded percent used by both labels above.
    private static func zoomPercent(for effectivePixelScale: CGFloat) -> Int {
        Int((effectivePixelScale * 100).rounded())
    }

    // MARK: - Canvas sentinels (UITest harness)

    /// Accessibility identifier the UITest harness watches to know the
    /// refine pass has published a preview AND `isRendering` flipped false.
    /// See `MAPLE_UITEST_FIXTURE` flow in `MapleUITests/`. The two-string
    /// vocabulary (`canvas-render-ready` / `canvas-rendering`) is the
    /// public contract — do not rename without updating the harness.
    static func canvasAccessibilityID(isRendering: Bool, hasPreview: Bool) -> String {
        (!isRendering && hasPreview) ? "canvas-render-ready" : "canvas-rendering"
    }

    /// True when the inline `ProgressView` spinner should be visible. The
    /// rule is "only while we have no preview yet" — slider ticks keep
    /// `isRendering == true` for tens of ms each, and flashing a spinner
    /// on every tick is worse than no spinner at all.
    static func shouldShowRenderIndicator(isRendering: Bool, hasPreview: Bool) -> Bool {
        isRendering && !hasPreview
    }

    // MARK: - Zoom math

    /// Upper clamp on `pixelScale`. Reference caps at 8× so a 24MP image
    /// can show pixel-level noise without the refine target blowing past
    /// sensible memory budgets. Exposed here so the view file can reference
    /// a single source of truth and the unit tests don't drift from it.
    static let maxPixelScale: CGFloat = 8.0

    /// Minimum scale floor applied by `setZoom(to:)` — keeps explicit
    /// keyboard / programmatic targets above a degenerate 0 (which would
    /// otherwise re-enter fit mode silently). Mirrors the reference's
    /// `max(scale, 0.05)` clamp.
    static let minExplicitZoom: CGFloat = 0.05

    /// Multiplier used by `zoomIn` / `zoomOut` keyboard shortcuts (⌘= / ⌘-).
    /// 1.25 yields the classic "five steps to double" feel from the
    /// reference implementation.
    static let zoomStep: CGFloat = 1.25

    /// Snap-to-fit threshold — when the user lets go of a pinch (or steps
    /// down with ⌘-) within 2% of fit, we reset to actual fit mode so the
    /// HUD reads cleanly and the refine pass uses viewport resolution.
    static let snapToFitTolerance: CGFloat = 1.02

    /// Resolves the live pinch math. `start` is the pixelScale captured at
    /// gesture begin; `magnification` is `MagnifyGesture.value.magnification`
    /// (cumulative since gesture begin). Clamps below to `fit * 0.5` so the
    /// user can pinch slightly past fit before we snap, and above to `max`.
    static func pinchScale(
        start: CGFloat,
        magnification: CGFloat,
        fit: CGFloat,
        maxScale: CGFloat = maxPixelScale
    ) -> CGFloat {
        max(fit * 0.5, min(start * magnification, maxScale))
    }

    /// True when `scale` is within `snapToFitTolerance` of `fit` and the
    /// view should reset to fit mode (pixelScale = 0). Used after the pinch
    /// gesture ends and after ⌘- steps down. Equivalent to the reference's
    /// `newScale <= fit * 1.02` check.
    static func shouldSnapToFit(_ scale: CGFloat, fit: CGFloat) -> Bool {
        scale <= fit * snapToFitTolerance
    }

    /// Clamps a programmatic zoom target (toolbar "100%", ⌘1) into the
    /// allowed range. Reference: `min(max(scale, 0.05), maxPixelScale)`.
    static func clampedExplicitZoom(_ scale: CGFloat, maxScale: CGFloat = maxPixelScale) -> CGFloat {
        min(max(scale, minExplicitZoom), maxScale)
    }

    /// Next scale after a ⌘= zoom-in step. `current` is the live effective
    /// pixel scale (so the first ⌘= out of fit actually moves the camera).
    static func zoomInTarget(current: CGFloat, maxScale: CGFloat = maxPixelScale) -> CGFloat {
        min(current * zoomStep, maxScale)
    }

    /// Outcome of a ⌘- zoom-out step. Either snap to fit (when the next
    /// step lands within tolerance) or take the clamped step. Modelled as
    /// an enum so the view file can pattern-match without re-running the
    /// snap-threshold check.
    enum ZoomOutResult: Equatable {
        /// Reset to fit mode (pixelScale = 0, pans cleared).
        case snapToFit
        /// Apply this concrete pixelScale and keep pans.
        case scale(CGFloat)
    }

    /// Computes the result of a ⌘- step from `current`. Mirrors the
    /// reference: divide by `zoomStep`, snap if within tolerance of fit,
    /// otherwise floor at `fit * 0.5` (so we can ease toward fit without
    /// undershooting wildly).
    static func zoomOutTarget(current: CGFloat, fit: CGFloat) -> ZoomOutResult {
        let next = current / zoomStep
        if next <= fit * snapToFitTolerance {
            return .snapToFit
        }
        return .scale(max(next, fit * 0.5))
    }

    // MARK: - Pan accumulation

    /// Accumulates a drag translation onto the base pan captured at gesture
    /// start. Pure point-arithmetic — no `@State` capture, no clamping.
    /// (Clamping pan against the visible source rect lives in `CanvasMath`
    /// in MapleCore; this helper only handles the additive step.)
    static func accumulatedPan(base: CGSize, translation: CGSize) -> CGSize {
        CGSize(
            width: base.width + translation.width,
            height: base.height + translation.height
        )
    }

    // MARK: - Viewport conversion

    /// Converts a SwiftUI viewport size (points) into real screen pixels
    /// using the environment's `displayScale`. The pipeline targets pixels
    /// — points only make sense at the SwiftUI boundary — so the view does
    /// this conversion once and passes the pixel-size onward.
    static func viewportInPixels(viewport: CGSize, displayScale: CGFloat) -> CGSize {
        CGSize(
            width: viewport.width * displayScale,
            height: viewport.height * displayScale
        )
    }
}
