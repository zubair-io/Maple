// CanvasImageView.swift — Pro Editor Canvas-first (A2, #1555).
//
// CIImage → SwiftUI raster for the editor canvas leaf.  Extracted from
// EditorView.swift to keep that file inside the per-file LoC budget (the
// codebase convention is one view per file).
//
// Lifted from `FullImageView.CIImageView` (the variant retired in #820) so
// the editor canvas paints through the same Display-P3 / 16-bit path — the
// visual-golden harness diffs this canvas against the golden the old wrapper
// produced, so the color path must match bit-for-bit.

import SwiftUI
import MapleCore

struct CanvasImageView: View, Equatable {
    let image: CIImage

    @Environment(\.displayScale) private var displayScale

    private static let context = CIContext()
    private static let outputColorSpace = CGColorSpace(name: CGColorSpace.displayP3)!

    // Render-skip contract (#2062): `body` runs a synchronous
    // `CIContext.createCGImage` raster — expensive enough that it must not
    // re-run just because a parent re-evaluated its own body during pan/zoom.
    // Equality is reference identity on `image`: this pipeline never mutates
    // a published `CIImage` in place (every edit publishes a *new* `CIImage`
    // instance — see `EditSession`/`ImageEditPipeline`), so the same instance
    // always denotes the same pixels. `===` is therefore both necessary
    // (value/structural equality on a `CIImage` filter graph is not
    // practically computable) and sufficient (identical instance implies
    // identical raster output) for this call site: same instance ⇒ skip the
    // re-raster, new instance ⇒ re-raster.
    //
    // `displayScale` (the only other stored property) is deliberately left
    // out of this comparison: it's an `@Environment` read, not a value the
    // call site constructs, and SwiftUI tracks environment-key dependencies
    // for a view's body independently of `EquatableView`/`.equatable()` —
    // a `displayScale` change invalidates and re-runs `body` on its own,
    // regardless of what this `==` returns. Including it here would just
    // require resolving `displayScale` on two instances outside their
    // normal tree-attached lifecycle for no correctness benefit.
    static func == (lhs: CanvasImageView, rhs: CanvasImageView) -> Bool {
        lhs.image === rhs.image
    }

    var body: some View {
        Group {
            if let cgImg = Self.context.createCGImage(
                image,
                from: image.extent,
                format: .RGBA16,
                colorSpace: Self.outputColorSpace
            ) {
                // `Image(decorative:scale:orientation:)` carries the
                // displayScale explicitly so a full-res cgImage scales down to
                // the proposed frame on macOS (NSImage's natural-size-in-points
                // path over-scales at displayScale=2). The parent frames this to
                // the resolved fit rect; `.fit` keeps the aspect inside it.
                Image(decorative: cgImg, scale: displayScale, orientation: .up)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            } else {
                Color.clear
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
