// FullImageView.swift — Full-resolution canvas with zoom/pan and before/after.

import SwiftUI
import CoreImage
import CoreImage.CIFilterBuiltins
import MapleCore

struct FullImageView: View {
    /// `EditSession` is `@Observable`; SwiftUI tracks property access directly.
    let session: EditSession

    @State private var scale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @State private var lastScale: CGFloat = 1.0
    /// Committed pan offset — accumulates across drag gestures so consecutive
    /// drags chain instead of snapping back to centre. Mirrors the
    /// `lastScale` pattern used for MagnifyGesture.
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        GeometryReader { geo in
            ZStack {
                // Background
                MapleTokens.imageCanvas.ignoresSafeArea()

                // Image canvas
                imageContent
                    .scaleEffect(scale)
                    .offset(offset)
                    .gesture(magnificationGesture(geo: geo))
                    .gesture(dragGesture(geo: geo))
                    .onTapGesture(count: 2) { resetZoom() }

                // Before/After overlay
                if session.showingOriginal {
                    VStack {
                        Spacer()
                        Text("BEFORE")
                            .font(.caption.bold())
                            .foregroundStyle(.white)
                            .padding(6)
                            .background(.black.opacity(0.6), in: Capsule())
                            .padding(.bottom, 12)
                    }
                }

                // Render error banner (populated by EditSession._render's catch).
                if let err = session.renderError {
                    VStack {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle.fill")
                            Text(err.localizedDescription)
                                .font(.caption)
                                .lineLimit(2)
                        }
                        .foregroundStyle(.white)
                        .padding(8)
                        .background(Color.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 6))
                        .padding(.top, 12)
                        Spacer()
                    }
                }

                // Render indicator
                if session.isRendering {
                    VStack {
                        Spacer()
                        HStack {
                            ProgressView()
                                .controlSize(.small)
                                .tint(.white)
                            Text(session.renderPhase == .fast ? "Fast render…" : "Refining…")
                                .font(.caption)
                                .foregroundStyle(.white)
                        }
                        .padding(8)
                        .background(.black.opacity(0.5), in: Capsule())
                        .padding(.bottom, 12)
                        Spacer()
                            .frame(height: 0)
                    }
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .toolbar {
            // Zoom controls
            ToolbarItemGroup(placement: .automatic) {
                Button("Fit", systemImage: "arrow.down.right.and.arrow.up.left") { resetZoom() }
                Button("100%", systemImage: "1.circle") {
                    scale = 1.0
                    offset = .zero
                    lastOffset = .zero
                }
            }
        }
    }

    @ViewBuilder
    private var imageContent: some View {
        if let ci = session.showingOriginal ? nil : session.renderedPreview {
            CIImageView(image: ci)
                .transition(.opacity)
        } else {
            // Placeholder while rendering
            RoundedRectangle(cornerRadius: 8)
                .fill(MapleTokens.surfaceAlt)
                .frame(maxWidth: 800, maxHeight: 600)
                .overlay {
                    Image(systemName: "photo")
                        .font(.system(size: 60))
                        .foregroundStyle(MapleTokens.textMuted)
                }
        }
    }

    private func magnificationGesture(geo: GeometryProxy) -> some Gesture {
        MagnifyGesture()
            .onChanged { v in scale = lastScale * v.magnification }
            .onEnded { _ in
                lastScale = max(0.1, min(scale, 20))
                scale = lastScale
                // If the user pinched back out to unity, re-centre.
                if scale <= 1.0 {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        offset = .zero
                        lastOffset = .zero
                    }
                } else {
                    // Clamp the existing pan to the new scale.
                    let clamped = clampOffset(offset, geo: geo, scale: scale)
                    offset = clamped
                    lastOffset = clamped
                }
            }
    }

    private func dragGesture(geo: GeometryProxy) -> some Gesture {
        DragGesture()
            .onChanged { v in
                let proposed = CGSize(
                    width: lastOffset.width + v.translation.width,
                    height: lastOffset.height + v.translation.height
                )
                offset = clampOffset(proposed, geo: geo, scale: scale)
            }
            .onEnded { _ in
                lastOffset = offset
            }
    }

    /// Clamp pan so the scaled image can't be dragged entirely off-screen.
    /// The scaled image's half-extent is `geo.size * (scale - 1) / 2`; once
    /// the centre moves past that, the image edge crosses the viewport edge
    /// and we pin it. At scale ≤ 1 there's nothing to pan.
    private func clampOffset(_ raw: CGSize, geo: GeometryProxy, scale: CGFloat) -> CGSize {
        guard scale > 1.0 else { return .zero }
        let maxX = (geo.size.width  * (scale - 1)) / 2
        let maxY = (geo.size.height * (scale - 1)) / 2
        return CGSize(
            width:  min(max(raw.width,  -maxX), maxX),
            height: min(max(raw.height, -maxY), maxY)
        )
    }

    private func resetZoom() {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
            scale = 1.0
            offset = .zero
            lastScale = 1.0
            lastOffset = .zero
        }
    }
}

// MARK: - CIImageView

/// Renders a CIImage into a SwiftUI view via a CGImage raster.
struct CIImageView: View {
    let image: CIImage

    private static let context = CIContext()

    var body: some View {
        if let cgImg = Self.context.createCGImage(image, from: image.extent) {
            #if os(macOS)
            Image(nsImage: NSImage(cgImage: cgImg, size: .zero))
                .resizable()
                .aspectRatio(contentMode: .fit)
            #else
            Image(uiImage: UIImage(cgImage: cgImg))
                .resizable()
                .aspectRatio(contentMode: .fit)
            #endif
        } else {
            Color.gray
        }
    }
}
