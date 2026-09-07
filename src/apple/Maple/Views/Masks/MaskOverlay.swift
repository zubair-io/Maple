// MaskOverlay.swift — translucent red tint of the selected mask's raster
// over the canvas (#3275, spec §3.2, §6.3). Visualizes ONLY the geometric
// raster (what Vision selected), not the live colour-range refinement — the
// vectorscope is what makes the refinement visible.
//
// Geometry follows the CANVAS, not a fit assumption (#3354): the raster is
// laid out exactly where `CanvasZoomHost` lays out the image —
// `displayFrameInPoints`, centred, offset by the pan — expanded back to the
// full frame when a crop is applied, and rotated by the straighten angle
// about the frame centre the way `CropImageStage` rotates the pixels. The
// first version used `CropGeometry.fitFootprint` like `CropOverlay`, which
// is correct only at fit zoom with zero pan; at any other zoom the red
// silhouette was a smaller, offset copy of the subject.

import MapleCore
import SwiftUI

struct MaskOverlay: View {
    @Bindable var state: EditorState
    @State private var previewImage: CGImage?

    private var selectedLayer: LocalAdjustment? {
        state.session.model.localAdjustments.first { $0.id == state.session.selectedMaskId }
    }

    var body: some View {
        GeometryReader { geo in
            if let previewImage, case .bitmap = selectedLayer?.mask,
                let frame = state.zoom.displayFrameInPoints,
                let full = MaskOverlayGeometry.fullFrameRect(
                    containerSize: geo.size, displayFrame: frame,
                    panOffset: state.zoom.panOffset, crop: state.session.model.crop)
            {
                let shown = state.session.showsMaskOverlay
                Image(decorative: previewImage, scale: 1)
                    .resizable()
                    .renderingMode(.template)
                    .foregroundStyle(.red.opacity(0.45))
                    .frame(width: full.width, height: full.height)
                    // Straighten rotates the full frame about its centre
                    // before the crop is cut; the raster is full-frame, so
                    // it rotates the same way. Positive = clockwise in both.
                    .rotationEffect(.degrees(state.session.model.crop.angle))
                    .position(x: full.midX, y: full.midY)
                    // Faded, not unmounted (#3364): dropping the view would
                    // re-run `loadRasterPreview` on every drag release and
                    // flash the raster back in after a decode.
                    .opacity(shown ? 1 : 0)
                    .animation(.easeInOut(duration: 0.12), value: shown)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .task(id: state.session.selectedMaskId) { await loadRasterPreview() }
    }

    @MainActor
    private func loadRasterPreview() async {
        guard let layer = selectedLayer, case .bitmap(let recipe, _) = layer.mask else {
            previewImage = nil
            return
        }
        let path = await state.session.maskRasterStore.cachedPath(digest: recipe.digest)
        guard let provider = CGDataProvider(url: path as CFURL) else {
            previewImage = nil
            return
        }
        guard
            let gray = CGImage(
                pngDataProviderSource: provider, decode: nil, shouldInterpolate: true,
                intent: .defaultIntent)
        else {
            previewImage = nil
            return
        }
        // Rasters are 8-bit GRAYSCALE with no alpha channel — coverage is
        // luminance. `.renderingMode(.template)` below tints by ALPHA, so
        // the raw raster (opaque everywhere) tinted the entire frame flat
        // red and the skin was indistinguishable from the background
        // (#3354). Convert coverage into alpha first.
        previewImage = MaskRasterAlpha.alphaFromLuminance(gray)
    }
}
