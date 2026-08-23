// MuiCanvasSurface.swift — Maple UI Canvas Surface atom.
// Contract: docs/design/maple-ui/components/canvas-surface.md

import SwiftUI

/// The reusable chrome around any GPU- or 2D-rendered layer — sizes and
/// letterboxes a rendering surface against the image-canvas backdrop
/// (canvas-surface.md §Purpose). Canvas Surface owns none of the actual
/// drawing; the caller's `content` closure is handed the letterboxed size
/// and paints into it with a SwiftUI `Canvas`, a `MTKView`-wrapping
/// `NSViewRepresentable`/`UIViewRepresentable`, or anything else — the
/// contract's own "Metal/WebGL2/2D-agnostic" framing, generic over
/// `Content` so this atom stays agnostic on Apple too.
public struct MuiCanvasSurface<Content: View>: View {
    public let contentAspect: CGFloat?
    public let loading: Bool
    public let onReady: (() -> Void)?
    public let content: (CGSize) -> Content

    public init(
        contentAspect: CGFloat? = nil,
        loading: Bool = false,
        onReady: (() -> Void)? = nil,
        @ViewBuilder content: @escaping (CGSize) -> Content
    ) {
        self.contentAspect = contentAspect
        self.loading = loading
        self.onReady = onReady
        self.content = content
    }

    public var body: some View {
        GeometryReader { geo in
            let size = letterboxedSize(in: geo.size)
            ZStack {
                MuiTokens.imageCanvas
                content(size)
                    .frame(width: size.width, height: size.height)
                if loading {
                    MuiSpinner(size: .md, placement: .centered)
                        .background(MuiTokens.imageCanvas.opacity(0.6))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .onAppear { if !loading { onReady?() } }
            .onChange(of: loading) { _, isLoading in
                if !isLoading { onReady?() }
            }
        }
        .accessibilityHidden(true)
    }

    private func letterboxedSize(in host: CGSize) -> CGSize {
        guard let contentAspect, contentAspect > 0, host.width > 0, host.height > 0 else { return host }
        let hostAspect = host.width / host.height
        if hostAspect > contentAspect {
            let height = host.height
            return CGSize(width: height * contentAspect, height: height)
        } else {
            let width = host.width
            return CGSize(width: width, height: width / contentAspect)
        }
    }
}

#Preview("MuiCanvasSurface — Letterboxed, ready") {
    MuiCanvasSurface(contentAspect: 3.0 / 2.0) { size in
        Canvas { context, canvasSize in
            context.fill(Path(CGRect(origin: .zero, size: canvasSize)), with: .color(MuiTokens.primaryDim))
        }
    }
    .frame(width: 240, height: 240)
    .background(MuiTokens.bg)
}

#Preview("MuiCanvasSurface — Loading") {
    MuiCanvasSurface(contentAspect: 3.0 / 2.0, loading: true) { _ in
        Color.clear
    }
    .frame(width: 240, height: 240)
    .background(MuiTokens.bg)
}
