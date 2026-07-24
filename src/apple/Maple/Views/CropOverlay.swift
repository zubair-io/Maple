// CropOverlay.swift — interactive crop / straighten overlay (#638).
//
// Mounted over the editor canvas while the Crop tool is armed (see
// EditorView's canvas ZStack). The canvas behind shows the image UNCROPPED
// (the render path strips the crop while `session.cropEditingActive`) and
// rotated by the straighten angle (a `.rotationEffect` on the canvas leaf);
// this view draws the axis-aligned crop rectangle, the darkened mask
// outside it, the rule-of-thirds grid, and the eight drag handles —
// matching the renderer's "rotate the frame, then cut an axis-aligned rect"
// model (spec § 3.12).
//
// Crop-rect edits are pure overlay math: dragging a handle mutates
// `session.model.crop`, which the canvas (rendering uncropped while armed)
// does NOT re-render for — so a drag costs zero pipeline work. The cropped
// result renders once, when the tool disarms.
//
// Geometry mirrors the web `CropOverlayComponent`: the footprint is the
// FULL-FRAME image's fit rect, centered in the canvas wrap (the crop tool
// forces fit + zero pan on entry, so the painted image maps 1:1 onto it),
// and all the pure math lives in `MapleCore.CropGeometry` so the platforms
// can't drift.

import SwiftUI
import MapleCore

struct CropOverlay: View {
    @Bindable var state: EditorState

    /// Grab radius for the handles, in points. Matches the web
    /// `HANDLE_TOLERANCE`.
    private let handleTolerance: Double = 14

    /// In-flight drag bookkeeping.
    private struct DragState {
        let handle: CropGeometry.Handle
        /// Crop at gesture start (for the `move` delta).
        let startCrop: Crop
        /// Pointer at gesture start, normalized (for the `move` delta).
        let startNx: Double
        let startNy: Double
        /// True once we've pushed the single undo snapshot for this gesture.
        var committed: Bool
    }

    @State private var drag: DragState?

    var body: some View {
        GeometryReader { geo in
            let wrapW = Double(geo.size.width)
            let wrapH = Double(geo.size.height)
            let dims = imageDims()
            let footprint = CropGeometry.fitFootprint(
                wrapW: wrapW, wrapH: wrapH, imgW: dims.w, imgH: dims.h
            )
            let cropRect = currentCrop()
            let rect = CropGeometry.cropRectToPx(cropRect, footprint)

            ZStack(alignment: .topLeading) {
                maskLayer(rect: rect, footprint: footprint)
                frameLayer(rect: rect)
                gridLayer(rect: rect)
                handleLayer(rect: rect)
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .contentShape(Rectangle())
            .gesture(dragGesture(footprint: footprint, imgW: dims.w, imgH: dims.h))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Crop and straighten")
            .accessibilityIdentifier("editor-crop-overlay")
        }
        .allowsHitTesting(true)
    }

    // MARK: - Layers

    private func maskLayer(rect: CropGeometry.PxRect, footprint: CropGeometry.Footprint) -> some View {
        // Four dark rectangles surrounding the crop box (top / bottom /
        // left / right), mirroring the web `maskRects` — but bounded to the
        // image's own footprint rather than the full canvas, so the mask
        // dims excluded PHOTO content only. Without this, fit-mode letterbox
        // bars (aspect-mismatched image) and the crop-margin border both read
        // as part of the mask instead of plain canvas background.
        let fpLeft = footprint.left
        let fpTop = footprint.top
        let fpRight = footprint.left + footprint.width
        let fpBottom = footprint.top + footprint.height
        let masks: [CGRect] = [
            CGRect(x: fpLeft, y: fpTop, width: footprint.width, height: max(0, rect.y - fpTop)),
            CGRect(x: fpLeft, y: rect.y + rect.height,
                   width: footprint.width, height: max(0, fpBottom - (rect.y + rect.height))),
            CGRect(x: fpLeft, y: rect.y, width: max(0, rect.x - fpLeft), height: rect.height),
            CGRect(x: rect.x + rect.width, y: rect.y,
                   width: max(0, fpRight - (rect.x + rect.width)), height: rect.height),
        ]
        return ZStack(alignment: .topLeading) {
            ForEach(Array(masks.enumerated()), id: \.offset) { _, m in
                Rectangle()
                    .fill(Color.black.opacity(0.55))
                    .frame(width: m.width, height: m.height)
                    .offset(x: m.minX, y: m.minY)
            }
        }
        .allowsHitTesting(false)
    }

    private func frameLayer(rect: CropGeometry.PxRect) -> some View {
        Rectangle()
            .stroke(Color.white.opacity(0.9), lineWidth: 1)
            .frame(width: CGFloat(rect.width), height: CGFloat(rect.height))
            .offset(x: CGFloat(rect.x), y: CGFloat(rect.y))
            .allowsHitTesting(false)
    }

    private func gridLayer(rect: CropGeometry.PxRect) -> some View {
        // Rule-of-thirds grid, mirroring the web `gridLines`.
        let v1 = rect.x + rect.width / 3
        let v2 = rect.x + 2 * rect.width / 3
        let h1 = rect.y + rect.height / 3
        let h2 = rect.y + 2 * rect.height / 3
        return Path { p in
            p.move(to: CGPoint(x: v1, y: rect.y))
            p.addLine(to: CGPoint(x: v1, y: rect.y + rect.height))
            p.move(to: CGPoint(x: v2, y: rect.y))
            p.addLine(to: CGPoint(x: v2, y: rect.y + rect.height))
            p.move(to: CGPoint(x: rect.x, y: h1))
            p.addLine(to: CGPoint(x: rect.x + rect.width, y: h1))
            p.move(to: CGPoint(x: rect.x, y: h2))
            p.addLine(to: CGPoint(x: rect.x + rect.width, y: h2))
        }
        .stroke(Color.white.opacity(0.35), lineWidth: 0.5)
        .allowsHitTesting(false)
    }

    private func handleLayer(rect: CropGeometry.PxRect) -> some View {
        // Four corner dots, mirroring the web `corners`. (Edge handles are
        // hit-tested by `CropGeometry.hitTestHandle` but draw nothing
        // distinct — the frame edge is their affordance, same as the web
        // edge bars; corners are the visible grab points.)
        let corners: [(Double, Double)] = [
            (rect.x, rect.y),
            (rect.x + rect.width, rect.y),
            (rect.x, rect.y + rect.height),
            (rect.x + rect.width, rect.y + rect.height),
        ]
        return ZStack(alignment: .topLeading) {
            ForEach(Array(corners.enumerated()), id: \.offset) { _, c in
                Circle()
                    .fill(Color.white)
                    .frame(width: 12, height: 12)
                    .offset(x: CGFloat(c.0) - 6, y: CGFloat(c.1) - 6)
            }
        }
        .allowsHitTesting(false)
    }

    // MARK: - Gesture

    private func dragGesture(
        footprint: CropGeometry.Footprint, imgW: Double, imgH: Double
    ) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let px = Double(value.location.x)
                let py = Double(value.location.y)
                if drag == nil {
                    // Begin: hit-test against the current rect; ignore drags
                    // that start outside a handle.
                    let rect = CropGeometry.cropRectToPx(currentCrop(), footprint)
                    guard let handle = CropGeometry.hitTestHandle(px, py, rect, handleTolerance)
                    else { return }
                    let start = CropGeometry.pxToNormalized(px, py, footprint)
                    drag = DragState(
                        handle: handle,
                        startCrop: currentCrop(),
                        startNx: start.nx,
                        startNy: start.ny,
                        committed: false
                    )
                }
                guard var d = drag else { return }
                if !d.committed {
                    // One undo entry per gesture — snapshot before the first
                    // mutation lands.
                    state.commit()
                    d.committed = true
                    drag = d
                }
                let norm = CropGeometry.pxToNormalized(px, py, footprint)
                let next: Crop
                if d.handle == .move {
                    next = CropGeometry.moveCrop(
                        d.startCrop, norm.nx - d.startNx, norm.ny - d.startNy
                    )
                } else {
                    let aspect = CropAspect.resolveAspect(
                        state.cropAspectPreset, imgW: imgW, imgH: imgH
                    )
                    next = CropGeometry.resizeCrop(
                        currentCrop(), d.handle, norm.nx, norm.ny,
                        CropGeometry.ResizeOptions(aspect: aspect, imgW: imgW, imgH: imgH)
                    )
                }
                applyCrop(next)
            }
            .onEnded { _ in
                drag = nil
            }
    }

    // MARK: - Model access

    /// The live crop rect from the session model.
    private func currentCrop() -> Crop {
        state.session.model.crop
    }

    /// Write a new crop rect onto the session model (persists to XMP via the
    /// model setter; no re-render while the crop tool is armed).
    private func applyCrop(_ crop: Crop) {
        state.session.model.crop = crop
    }

    /// Full-frame (display-oriented) image dimensions. Falls back to a 3:2
    /// frame before the metadata seed publishes real dims, matching the web
    /// overlay's default.
    private func imageDims() -> (w: Double, h: Double) {
        let native = state.session.nativeImageSize
        if native.width > 0, native.height > 0 {
            return (Double(native.width), Double(native.height))
        }
        return (6240, 4160)
    }
}
