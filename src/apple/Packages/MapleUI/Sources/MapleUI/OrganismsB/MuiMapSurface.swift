// MuiMapSurface.swift — Maple UI Organisms · Map (unified-component-
// catalog.md §4.6). A reference map surface — NOT MapKit. A pannable
// token-styled grid backdrop with projected pin annotations, simple
// distance-threshold clustering, and an optional density heatmap overlay,
// built from Map Annotation, Heatmap Layer, Empty State.
//
// Coordinates: each annotation's `x`/`y` are already-normalized 0...1
// values — this view only turns that into screen points
// (`screenX = x * viewportWidth + panX`). Clustering and the heatmap grid
// are pure functions in `MuiMapSurfaceMath`, shared and unit-tested.

import SwiftUI

public struct MuiMapSurfaceAnnotation: Identifiable, Sendable {
    public let id: String
    public let x: Double
    public let y: Double
    public let label: String?
    public let thumbnailUrl: URL?

    public init(id: String, x: Double, y: Double, label: String? = nil, thumbnailUrl: URL? = nil) {
        self.id = id
        self.x = x
        self.y = y
        self.label = label
        self.thumbnailUrl = thumbnailUrl
    }
}

public struct MuiMapSurface: View {
    public let annotations: [MuiMapSurfaceAnnotation]
    @Binding public var heatmapVisible: Bool
    public let clusterThreshold: CGFloat
    public let annotationSelected: ((String) -> Void)?
    public let panChanged: ((CGPoint) -> Void)?

    @State private var pan: CGPoint = .zero
    @State private var dragStartPan: CGPoint = .zero

    public init(
        annotations: [MuiMapSurfaceAnnotation],
        heatmapVisible: Binding<Bool>,
        clusterThreshold: CGFloat = 40,
        annotationSelected: ((String) -> Void)? = nil,
        panChanged: ((CGPoint) -> Void)? = nil
    ) {
        self.annotations = annotations
        self._heatmapVisible = heatmapVisible
        self.clusterThreshold = clusterThreshold
        self.annotationSelected = annotationSelected
        self.panChanged = panChanged
    }

    public var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topTrailing) {
                MuiTokens.imageCanvas
                gridBackdrop

                if heatmapVisible {
                    MuiHeatmapLayer(
                        grid: MuiMapSurfaceMath.heatmapGrid(normalizedPoints: annotations.map { ($0.x, $0.y) }),
                        width: geo.size.width,
                        height: geo.size.height
                    )
                }

                ForEach(clusters(in: geo.size)) { pin in
                    MuiMapAnnotation(url: pin.thumbnailUrl, label: pin.count.map { "\($0) photos" } ?? pin.label, count: pin.count)
                        .position(x: pin.screenX, y: pin.screenY)
                        .onTapGesture { annotationSelected?(pin.memberIds.first ?? pin.id) }
                }

                if annotations.isEmpty {
                    MuiEmptyState(icon: "map", title: "No located photos", message: "Photos with GPS data will appear here.")
                }

                MuiButton(label: heatmapVisible ? "Hide density" : "Show density", variant: .secondary, size: .sm, leadingIcon: "flame") {
                    heatmapVisible.toggle()
                }
                .padding(MuiTokens.spacingSm)
            }
            .contentShape(Rectangle())
            .gesture(panGesture)
            .clipped()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Map surface")
    }

    private var gridBackdrop: some View {
        Canvas { context, size in
            let step: CGFloat = 32
            var x: CGFloat = pan.x.truncatingRemainder(dividingBy: step)
            while x < size.width {
                context.stroke(Path { $0.move(to: CGPoint(x: x, y: 0)); $0.addLine(to: CGPoint(x: x, y: size.height)) }, with: .color(MuiTokens.border.opacity(0.4)))
                x += step
            }
            var y: CGFloat = pan.y.truncatingRemainder(dividingBy: step)
            while y < size.height {
                context.stroke(Path { $0.move(to: CGPoint(x: 0, y: y)); $0.addLine(to: CGPoint(x: size.width, y: y)) }, with: .color(MuiTokens.border.opacity(0.4)))
                y += step
            }
        }
    }

    private func clusters(in size: CGSize) -> [MuiMapPin] {
        let positioned = annotations.map { annotation in
            MuiMapPositionedAnnotation(
                id: annotation.id, normalizedX: annotation.x, normalizedY: annotation.y,
                label: annotation.label, thumbnailUrl: annotation.thumbnailUrl,
                screenX: annotation.x * size.width + pan.x, screenY: annotation.y * size.height + pan.y
            )
        }
        return MuiMapSurfaceMath.groupByDistance(positioned, threshold: clusterThreshold).map(MuiMapSurfaceMath.toClusterPin)
    }

    private var panGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                pan = CGPoint(x: dragStartPan.x + value.translation.width, y: dragStartPan.y + value.translation.height)
            }
            .onEnded { _ in
                dragStartPan = pan
                panChanged?(pan)
            }
    }
}

#Preview("MuiMapSurface") {
    struct Demo: View {
        @State private var heatmap = false
        var body: some View {
            MuiMapSurface(
                annotations: [
                    MuiMapSurfaceAnnotation(id: "1", x: 0.2, y: 0.3, label: "Reykjavik"),
                    MuiMapSurfaceAnnotation(id: "2", x: 0.22, y: 0.31, label: "Reykjavik 2"),
                    MuiMapSurfaceAnnotation(id: "3", x: 0.7, y: 0.6, label: "Vik"),
                ],
                heatmapVisible: $heatmap
            )
            .frame(width: 320, height: 220)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
