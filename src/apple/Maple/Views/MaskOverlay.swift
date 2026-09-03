// MaskOverlay.swift — interactive local-adjustment mask overlay (#355).
//
// Mounted over the editor canvas while the Mask tool is armed (see
// EditorView's canvas ZStack), the sibling of `CropOverlay`. Draws the
// SELECTED layer only: a translucent red weight visualisation (a direct
// read of `w ∈ [0, 1]` through `MaskWeight`, the Swift port of raw-core's
// evaluator, so the tint IS what the render applies) and the shape's drag
// handles — pin + axis for a linear gradient, center + two radius pins +
// a rotation pin for a radial mask.
//
// Every drag writes `session.model.localAdjustments[selected].mask`, which
// re-renders the canvas live through the GPU chain (the layer stack rides
// `MapleGpuLiveParams.local_adjustments_*`). One undo entry per gesture,
// opened by `EditorState.beginMaskGesture()` on the first movement.
//
// Geometry: the footprint is the DISPLAYED image's fit rect (the mask tool
// forces fit + zero pan on entry, so the painted image maps 1:1 onto it);
// `MaskCanvasMap` folds the applied crop/straighten in, so a mask on a
// cropped image is drawn exactly where the render applies it. The pure
// math lives in `MapleCore.MaskGeometry` so it is unit-tested in isolation.

import SwiftUI
import MapleCore

struct MaskOverlay: View {
    @Bindable var state: EditorState

    /// Grab radius for the handles, in points — matches `CropOverlay`.
    private let handleTolerance: Double = 14

    private struct DragState {
        let handle: MaskHandle
        let startMask: LocalMask
        let anchor: MaskPoint
    }

    @State private var drag: DragState?

    var body: some View {
        GeometryReader { geo in
            let dims = imageDims()
            let footprint = CropGeometry.fitFootprint(
                wrapW: Double(geo.size.width), wrapH: Double(geo.size.height),
                imgW: dims.w, imgH: dims.h)
            let map = MaskCanvasMap(
                footprint: footprint, crop: state.session.model.crop,
                nativeSize: state.session.nativeImageSize)

            ZStack(alignment: .topLeading) {
                if let mask = state.selectedMask?.mask {
                    weightLayer(mask: mask, map: map)
                    shapeLayer(mask: mask, map: map)
                    handleLayer(mask: mask, map: map)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .contentShape(Rectangle())
            .gesture(dragGesture(map: map))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Mask overlay")
            .accessibilityValue(state.selectedMask.map(Self.describe) ?? "No mask selected")
            .accessibilityIdentifier("editor-mask-overlay")
        }
    }

    // MARK: - Weight visualisation

    /// Raster resolution of the tint along the footprint's long edge. The
    /// tint is a UI overlay (not the render loop): ~25k evaluations per
    /// drag frame, drawn upscaled with bilinear filtering.
    private static let tintLongEdge = 192

    private func weightLayer(mask: LocalMask, map: MaskCanvasMap) -> some View {
        let fp = map.footprint
        let image = MaskWeightRaster.image(
            mask: mask, cropToFull: map.cropToFull,
            aspect: fp.width > 0 && fp.height > 0 ? fp.width / fp.height : 1.5,
            longEdge: Self.tintLongEdge)
        return Group {
            if let image {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .interpolation(.medium)
                    .frame(width: CGFloat(fp.width), height: CGFloat(fp.height))
                    .offset(x: CGFloat(fp.left), y: CGFloat(fp.top))
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    // MARK: - Shape

    private func shapeLayer(mask: LocalMask, map: MaskCanvasMap) -> some View {
        Path { p in
            switch mask {
            case .linear(let start, let end, _):
                p.move(to: map.toScreen(start))
                p.addLine(to: map.toScreen(end))
            case .radial(let center, let radii, let angle, _, _):
                let outline = MaskGeometry.ellipseOutline(center: center, radii: radii, angle: angle)
                    .map(map.toScreen)
                guard let first = outline.first else { return }
                p.move(to: first)
                outline.dropFirst().forEach { p.addLine(to: $0) }
                p.closeSubpath()
                // Rotation lead: from the x-radius pin out to the rotation pin.
                let handles = Dictionary(uniqueKeysWithValues: MaskGeometry.handles(for: mask).map { ($0.handle, $0.point) })
                if let rx = handles[.radialRadiusX], let rot = handles[.radialRotate] {
                    p.move(to: map.toScreen(rx))
                    p.addLine(to: map.toScreen(rot))
                }
            }
        }
        .stroke(Color.white.opacity(0.9), style: StrokeStyle(lineWidth: 1, dash: [6, 4]))
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    // MARK: - Handles

    private func handleLayer(mask: LocalMask, map: MaskCanvasMap) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(MaskGeometry.handles(for: mask), id: \.handle) { entry in
                let s = map.toScreen(entry.point)
                let diameter: CGFloat = entry.handle == .linearBody || entry.handle == .radialCenter ? 14 : 12
                Circle()
                    .fill(entry.handle == .radialRotate ? ProTokens.accent : Color.white)
                    .overlay(Circle().stroke(Color.black.opacity(0.5), lineWidth: 1))
                    .frame(width: diameter, height: diameter)
                    .offset(x: s.x - diameter / 2, y: s.y - diameter / 2)
                    .accessibilityElement()
                    .accessibilityLabel("Mask handle: \(entry.handle.accessibilityName)")
                    .accessibilityIdentifier("editor-mask-handle-\(entry.handle.rawValue)")
            }
        }
        .allowsHitTesting(false)
    }

    // MARK: - Gesture

    private func dragGesture(map: MaskCanvasMap) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if drag == nil {
                    guard let mask = state.selectedMask?.mask,
                          let handle = MaskGeometry.hitTest(
                              value.location, mask: mask, map: map, tolerance: handleTolerance)
                    else { return }
                    drag = DragState(handle: handle, startMask: mask, anchor: map.fromScreen(value.location))
                    // One undo entry per gesture — opened before the first
                    // mutation lands.
                    state.beginMaskGesture()
                }
                guard let d = drag else { return }
                state.setSelectedMaskShape(
                    MaskGeometry.dragged(d.startMask, handle: d.handle, to: map.fromScreen(value.location), from: d.anchor))
            }
            .onEnded { _ in
                drag = nil
                state.endMaskGesture()
            }
    }

    // MARK: - Helpers

    /// Displayed (cropped) image dimensions — the extent the canvas frames at
    /// fit. Falls back to a 3:2 frame before the metadata seed publishes real
    /// dims, matching `CropOverlay`.
    private func imageDims() -> (w: Double, h: Double) {
        let size = state.session.effectiveImageSize
        if size.width > 0, size.height > 0 {
            return (Double(size.width), Double(size.height))
        }
        return (6240, 4160)
    }

    private static func describe(_ layer: LocalAdjustment) -> String {
        switch layer.mask {
        case .linear: return "Linear gradient mask"
        case .radial(_, _, _, _, let invert): return invert ? "Inverted radial mask" : "Radial mask"
        }
    }
}

// MARK: - Weight raster

/// Rasterises a mask's weight into a translucent red RGBA image over the
/// DISPLAYED footprint: each raster pixel is a crop-normalized point,
/// mapped to full-frame coordinates through `cropToFull` and evaluated with
/// `MaskWeight` — the same math the render pipeline runs.
enum MaskWeightRaster {
    /// Tint colour (ProTokens.accent, 0xC4493A) and peak opacity.
    private static let tint: (r: UInt8, g: UInt8, b: UInt8) = (0xC4, 0x49, 0x3A)
    private static let peakAlpha: Double = 0.55

    static func image(mask: LocalMask, cropToFull: MaskAffine, aspect: Double, longEdge: Int) -> CGImage? {
        let width = aspect >= 1 ? longEdge : max(1, Int((Double(longEdge) * aspect).rounded()))
        let height = aspect >= 1 ? max(1, Int((Double(longEdge) / aspect).rounded())) : longEdge
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for j in 0..<height {
            let v = (Double(j) + 0.5) / Double(height)
            for i in 0..<width {
                let u = (Double(i) + 0.5) / Double(width)
                let p = cropToFull.apply(MaskPoint(x: u, y: v))
                let w = MaskWeight.evaluate(mask, x: p.x, y: p.y)
                let alpha = UInt8((min(1, max(0, w)) * peakAlpha * 255).rounded())
                let base = (j * width + i) * 4
                // Premultiplied RGBA, the layout `CGImageAlphaInfo.premultipliedLast` reads.
                pixels[base] = UInt8((Double(tint.r) * Double(alpha) / 255).rounded())
                pixels[base + 1] = UInt8((Double(tint.g) * Double(alpha) / 255).rounded())
                pixels[base + 2] = UInt8((Double(tint.b) * Double(alpha) / 255).rounded())
                pixels[base + 3] = alpha
            }
        }
        guard let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
        return CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }
}
