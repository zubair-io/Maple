// FullImageView+VM.swift — Pure-function canvas view-model helpers.
//
// Originally the co-located `+VM.swift` sibling of the legacy `FullImageView`
// (retired in #1807). `EditorView` (`EditorView+Canvas.swift`, `PillHeader`)
// and the shared `CanvasZoomHost` now consume the same helpers — the
// `FullImageViewVM` namespace + filename stayed as-is rather than a
// mechanical rename across every call site, since nothing about the name is
// load-bearing beyond "the shared canvas VM helpers." Holds derivations and
// formatters that take typed inputs and return typed outputs — no SwiftUI,
// no @State, no gestures. Callers feed the returned values back into their
// body + gesture closures.
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

/// Namespace for the shared canvas-derivation helpers (zoom labels, canvas
/// sentinels, GPU/CPU path selection). A caseless enum keeps the helpers
/// grouped without ever being instantiated. All members are static.
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

    // MARK: - Canvas path selection (GPU live vs CPU)

    /// True when the canvas should present via the wgpu live path
    /// (`GpuLiveCanvasView` → `CAMetalLayer`), false when it should raster
    /// `renderedPreview` through the CPU `CIImageView`. All three terms must
    /// hold:
    ///
    ///   * `flagEnabled` — the runtime GPU-live gate (`GpuLiveFlag.isEnabled`,
    ///     default on / `MAPLE_GPU_LIVE != 0`).
    ///   * `!showingOriginal` — the before/after "original" overlay always uses
    ///     the CPU path (the GPU chain presents the edited frame, it has no
    ///     before-image to show).
    ///
    /// (#1331 removed the `isRaw` term: the GPU live chain now handles non-RAW
    /// `InputShape::LinearRec2020Fp16` too — JPEG / HEIF / pano PNG. Keeping
    /// `isRaw` here mounted the CPU canvas for non-RAW assets so
    /// `driver.register(layer:)` never fired, every tick rejected `no-layer`,
    /// and the chain stayed on CPU. The `isRaw` external label is preserved on
    /// the signature for callers that pass it, but the parameter is bound to
    /// `_` — the asset type is irrelevant.)
    ///
    /// `presentFailed` (#1769): once a GPU present has THROWN for this session
    /// (`EditSession.gpuPresentFailed`), the GPU canvas must unmount — a torn
    /// drawable has no GPU repaint path, and the CPU fallback render that the
    /// failure triggered publishes to `renderedPreview`, which only the CPU
    /// leaf displays.
    static func shouldPresentViaGpuCanvas(
        flagEnabled: Bool,
        isRaw _: Bool,
        showingOriginal: Bool,
        presentFailed: Bool = false
    ) -> Bool {
        flagEnabled && !showingOriginal && !presentFailed
    }

    // MARK: - Zoom math
    //
    // The zoom constants + transition math (max scale, snap-to-fit
    // threshold, pinch / step / explicit-zoom clamps, pan accumulation)
    // moved to `MapleCore.CanvasZoomModel` in #1099 so the shared canvas
    // host, the editor, and the unit tests source one implementation.
}
