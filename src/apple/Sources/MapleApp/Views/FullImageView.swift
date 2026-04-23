// FullImageView.swift — Full-resolution canvas with zoom/pan and before/after.

import SwiftUI
import CoreImage
import CoreImage.CIFilterBuiltins
import MapleCore

struct FullImageView: View {
    @ObservedObject var session: EditSession

    @State private var scale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @State private var lastScale: CGFloat = 1.0

    var body: some View {
        GeometryReader { geo in
            ZStack {
                // Background
                MapleTokens.imageCanvas.ignoresSafeArea()

                // Image canvas
                imageContent
                    .scaleEffect(scale)
                    .offset(offset)
                    .gesture(magnificationGesture)
                    .gesture(dragGesture)
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
                Button("100%", systemImage: "1.circle") { scale = 1.0; offset = .zero }
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

    private var magnificationGesture: some Gesture {
        MagnifyGesture()
            .onChanged { v in scale = lastScale * v.magnification }
            .onEnded { v in
                lastScale = scale
                scale = max(0.1, min(scale, 20))
            }
    }

    private var dragGesture: some Gesture {
        DragGesture()
            .onChanged { v in
                offset = CGSize(
                    width: v.translation.width,
                    height: v.translation.height
                )
            }
            .onEnded { v in
                offset = CGSize(
                    width: offset.width + v.translation.width,
                    height: offset.height + v.translation.height
                )
                offset = .zero  // simple: reset drag to center; real panning state in P8
            }
    }

    private func resetZoom() {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
            scale = 1.0
            offset = .zero
            lastScale = 1.0
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
