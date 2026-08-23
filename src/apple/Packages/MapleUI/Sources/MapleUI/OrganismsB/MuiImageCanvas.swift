// MuiImageCanvas.swift — Maple UI Organisms · Editing surfaces
// (unified-component-catalog.md §4.5). Zoom, pan, before/after, and a
// crop-mode host, built from Canvas Surface, Preview Image, Crop Overlay.
//
// This is the reusable chrome + interaction math (real pinch-zoom-to-cursor
// and drag-to-pan via `MuiImageCanvasMath`, shared and unit-tested with the
// web reference's `zoomToPoint`), NOT the real Rust/WASM render pipeline —
// the reference image is drawn via `MuiCanvasSurface`/`MuiImage`, matching
// the mandate not to touch the GPU pipeline from this design-system
// package.

import SwiftUI

public struct MuiImageCanvas: View {
    public let url: URL?
    public let beforeUrl: URL?
    public let showBefore: Bool
    public let cropMode: Bool
    @Binding public var cropRect: MuiCropRect
    public let transformChanged: ((MuiImageTransform) -> Void)?
    public let cropRectChanged: ((MuiCropRect) -> Void)?

    @State private var transform = MuiImageTransform()
    @State private var dragStartTransform = MuiImageTransform()
    @GestureState private var magnifyStart: CGFloat?

    public init(
        url: URL?,
        beforeUrl: URL? = nil,
        showBefore: Bool = false,
        cropMode: Bool = false,
        cropRect: Binding<MuiCropRect> = .constant(MuiCropRect(x: 0, y: 0, width: 100, height: 100)),
        transformChanged: ((MuiImageTransform) -> Void)? = nil,
        cropRectChanged: ((MuiCropRect) -> Void)? = nil
    ) {
        self.url = url
        self.beforeUrl = beforeUrl
        self.showBefore = showBefore
        self.cropMode = cropMode
        self._cropRect = cropRect
        self.transformChanged = transformChanged
        self.cropRectChanged = cropRectChanged
    }

    private var activeUrl: URL? {
        showBefore ? (beforeUrl ?? url) : url
    }

    public var body: some View {
        MuiCanvasSurface(contentAspect: 3.0 / 2.0) { size in
            ZStack {
                image

                if cropMode {
                    MuiCropOverlay(containerSize: size, rect: $cropRect, committed: { cropRectChanged?($0) })
                }
            }
            .contentShape(Rectangle())
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(showBefore ? "Before image" : "After image")
    }

    @ViewBuilder
    private var image: some View {
        let base = MuiPreviewImage(url: activeUrl, alt: "Editing preview", fit: .fill, radius: .none)
            .scaleEffect(transform.scale)
            .offset(x: transform.x, y: transform.y)
            .clipped()

        if cropMode {
            base
        } else {
            base
                .gesture(panGesture)
                .simultaneousGesture(magnifyGesture)
        }
    }

    private var panGesture: some Gesture {
        DragGesture(minimumDistance: 2)
            .onChanged { value in
                transform = MuiImageCanvasMath.panned(startTransform: dragStartTransform, dx: value.translation.width, dy: value.translation.height)
            }
            .onEnded { _ in
                dragStartTransform = transform
                transformChanged?(transform)
            }
    }

    private var magnifyGesture: some Gesture {
        MagnifyGesture()
            .updating($magnifyStart) { _, state, _ in
                if state == nil { state = transform.scale }
            }
            .onChanged { value in
                let base = magnifyStart ?? transform.scale
                let nextScale = MuiImageCanvasMath.clampScale(base * value.magnification)
                transform = MuiImageCanvasMath.zoomToPoint(transform: transform, anchorX: 0, anchorY: 0, nextScale: nextScale)
            }
            .onEnded { _ in
                dragStartTransform = transform
                transformChanged?(transform)
            }
    }
}

#Preview("MuiImageCanvas") {
    struct Demo: View {
        @State private var cropRect = MuiCropRect(x: 30, y: 20, width: 160, height: 100)
        var body: some View {
            MuiImageCanvas(url: nil, cropMode: true, cropRect: $cropRect)
                .frame(width: 300, height: 200)
                .padding()
                .background(MuiTokens.bg)
        }
    }
    return Demo()
}
