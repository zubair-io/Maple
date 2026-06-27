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

struct CanvasImageView: View {
    let image: CIImage

    @Environment(\.displayScale) private var displayScale

    private static let context = CIContext()
    private static let outputColorSpace = CGColorSpace(name: CGColorSpace.displayP3)!

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
