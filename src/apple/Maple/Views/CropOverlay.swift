// CropOverlay.swift — interactive crop / straighten overlay (#638).
//
// Mounted over the editor canvas while the Crop tool is armed (see
// EditorView's canvas ZStack). The canvas behind shows the image UNCROPPED
// (the render path strips the crop while `session.cropEditingActive`) and
// rotated by the straighten angle (a `.rotationEffect` on the canvas leaf),
// matching the renderer's "rotate the frame, then cut an axis-aligned rect"
// model (spec § 3.12).
//
// The dimmed mask, frame, rule-of-thirds grid and corner dots are drawn by
// the shared Rust overlay renderer into their own upright layer
// (`CropOverlayLayerView`, #5715). This view keeps what stays native: the
// drag gesture and one accessible element per handle, positioned from the
// same Rust geometry.
//
// Crop-rect edits are pure overlay work: dragging a handle mutates
// `session.model.crop`, which the canvas (rendering uncropped while armed)
// does NOT re-render for, and redraws only the overlay layer. The cropped
// result renders once, when the tool disarms.
//
// The footprint is the FULL-FRAME image's fit rect, centered in the canvas
// wrap (zoom is held at fit + zero pan while the crop tool is armed, #5743,
// so the painted image maps 1:1 onto it); all the geometry lives in
// `MapleCore.CropGeometry`.

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

    @Environment(\.displayScale) private var displayScale

    var body: some View {
        GeometryReader { geo in
            let wrapW = Double(geo.size.width)
            let wrapH = Double(geo.size.height)
            let dims = imageDims()
            let footprint = CropGeometry.fitFootprint(
                wrapW: wrapW, wrapH: wrapH, imgW: dims.w, imgH: dims.h
            )
            let input = CropOverlayInput(
                crop: currentCrop(),
                viewport: geo.size,
                imageSize: CGSize(width: dims.w, height: dims.h),
                pixelScale: Double(displayScale),
                activeHandle: drag?.handle
            )

            ZStack(alignment: .topLeading) {
                CropOverlayLayerView(input: input)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                ForEach(CropOverlaySurface.accessibleHandles, id: \.self) { handle in
                    handleElement(handle, input: input)
                }
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

    // MARK: - Accessibility

    /// An invisible element over one handle, sized to its grab area, so
    /// VoiceOver can find each corner and edge of the crop.
    private func handleElement(_ handle: CropGeometry.Handle, input: CropOverlayInput) -> some View {
        Color.clear
            .frame(width: handleTolerance * 2, height: handleTolerance * 2)
            .allowsHitTesting(false)
            .accessibilityElement()
            .accessibilityLabel(Self.handleLabel(handle))
            .accessibilityIdentifier("editor-crop-handle-\(handle.rawValue)")
            .position(CropOverlaySurface.handleCenter(handle, input))
    }

    private static func handleLabel(_ handle: CropGeometry.Handle) -> String {
        switch handle {
        case .tl: return "Top-left crop handle"
        case .tr: return "Top-right crop handle"
        case .bl: return "Bottom-left crop handle"
        case .br: return "Bottom-right crop handle"
        case .t: return "Top crop edge"
        case .b: return "Bottom crop edge"
        case .l: return "Left crop edge"
        case .r: return "Right crop edge"
        case .move: return "Crop area"
        }
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
                    // One transaction per gesture (#2432) — opened before the
                    // first mutation lands, closed in `onEnded` below.
                    state.commit(kind: .crop, description: "Crop")
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
                state.session.endEdit()
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
