// MaskOverlay.swift — translucent red tint of the selected mask's raster
// over the canvas (#3275, spec §3.2, §6.3). Visualizes ONLY the geometric
// raster (what Vision selected), not the live colour-range refinement — the
// vectorscope is what makes the refinement visible. Geometry mirrors
// CropOverlay: GeometryReader + CropGeometry.fitFootprint, since the mask
// tool (like Crop) shows the image at fit zoom with zero pan.

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
            if let previewImage, case .bitmap = selectedLayer?.mask {
                let dims = (w: Double(previewImage.width), h: Double(previewImage.height))
                let footprint = CropGeometry.fitFootprint(
                    wrapW: Double(geo.size.width), wrapH: Double(geo.size.height), imgW: dims.w, imgH: dims.h)
                Image(decorative: previewImage, scale: 1)
                    .resizable()
                    .renderingMode(.template)
                    .foregroundStyle(.red.opacity(0.45))
                    .frame(width: CGFloat(footprint.width), height: CGFloat(footprint.height))
                    .position(
                        x: CGFloat(footprint.left + footprint.width / 2),
                        y: CGFloat(footprint.top + footprint.height / 2)
                    )
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .task(id: state.session.selectedMaskId) { await loadRasterPreview() }
    }

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
        previewImage = CGImage(pngDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }
}
