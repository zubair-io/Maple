// MoleculesL1PlotsGallery.swift — Molecules L1 tab, catalog §2.6 Data
// plots: Histogram, Waveform, Parade, Vectorscope, Curve Plot,
// Connection Graph, Heatmap Layer. Every plot renders fixed, deterministic
// sample data (no live image/telemetry source in the gallery).

import SwiftUI

extension MoleculesL1GallerySection2 {
    var histogramCard: some View {
        GallerySpecimenCard(name: "Histogram", purpose: "RGB distribution plot", builtFrom: "(none — plot primitive)") {
            MuiHistogram(
                r: (0..<48).map { i in Int(40 * exp(-pow(Double(i - 30) / 8, 2))) },
                g: (0..<48).map { i in Int(40 * exp(-pow(Double(i - 24) / 10, 2))) },
                b: (0..<48).map { i in Int(40 * exp(-pow(Double(i - 16) / 6, 2))) },
                width: 200,
                height: 56
            )
        }
    }

    var waveformCard: some View {
        GallerySpecimenCard(name: "Waveform", purpose: "Luma waveform", builtFrom: "(none — plot primitive)") {
            MuiWaveform(luma: (0..<64).map { 0.5 + 0.4 * sin(Double($0) / 5) }, width: 200, height: 56)
        }
    }

    var paradeCard: some View {
        GallerySpecimenCard(name: "Parade", purpose: "Three-channel waveform", builtFrom: "(none — plot primitive)") {
            MuiParade(
                r: (0..<32).map { 0.5 + 0.4 * sin(Double($0) / 3) },
                g: (0..<32).map { 0.5 + 0.3 * cos(Double($0) / 4) },
                b: (0..<32).map { 0.4 + 0.3 * sin(Double($0) / 2.5) },
                width: 200,
                height: 56
            )
        }
    }

    var vectorscopeCard: some View {
        GallerySpecimenCard(name: "Vectorscope", purpose: "Chroma scatter plot", builtFrom: "(none — plot primitive)") {
            MuiVectorscope(samples: (0..<150).map { i in
                let t = Double(i) / 150
                return MuiVectorscopeSample(r: 0.5 + 0.4 * sin(t * 12), g: 0.5 + 0.3 * cos(t * 9), b: 0.5 + 0.2 * sin(t * 5))
            }, size: 88)
        }
    }

    var curvePlotCard: some View {
        GallerySpecimenCard(name: "Curve Plot", purpose: "Draggable point curve", builtFrom: "(none — plot primitive)") {
            MuiCurvePlot(points: .constant([
                MuiCurvePoint(x: 0, y: 0.05),
                MuiCurvePoint(x: 0.35, y: 0.55),
                MuiCurvePoint(x: 0.7, y: 0.6),
                MuiCurvePoint(x: 1, y: 0.95),
            ]), width: 140, height: 100)
        }
    }

    var connectionGraphCard: some View {
        GallerySpecimenCard(name: "Connection Graph", purpose: "Node-link graph", builtFrom: "(none — plot primitive)") {
            let layout = MuiConnectionGraphMath.circularLayout(nodeCount: 5)
            let nodes = layout.enumerated().map { index, position in
                MuiConnectionGraphNode(id: "n\(index)", label: "N\(index)", x: position.x, y: position.y)
            }
            MuiConnectionGraph(
                nodes: nodes,
                links: [
                    MuiConnectionGraphLink(source: "n0", target: "n1"),
                    MuiConnectionGraphLink(source: "n1", target: "n2"),
                    MuiConnectionGraphLink(source: "n2", target: "n3"),
                    MuiConnectionGraphLink(source: "n3", target: "n4"),
                    MuiConnectionGraphLink(source: "n4", target: "n0"),
                ],
                width: 160,
                height: 96
            )
        }
    }

    var heatmapLayerCard: some View {
        GallerySpecimenCard(name: "Heatmap Layer", purpose: "Density overlay synced to a camera", builtFrom: "(none — plot primitive)") {
            MuiHeatmapLayer(grid: Self.heatmapSampleGrid, width: 140, height: 84)
                .background(MuiTokens.imageCanvas)
        }
    }

    /// A small radial-falloff grid — kept as a precomputed constant rather
    /// than an inline nested `.map` closure, which the type checker
    /// otherwise struggles to solve in reasonable time inside a
    /// SwiftUI `ViewBuilder` body.
    private static let heatmapSampleGrid: [[Double]] = (0..<8).map { row -> [Double] in
        (0..<8).map { col -> Double in
            let distance: Double = Double(abs(row - 4) + abs(col - 4))
            return Swift.max(0, 1 - distance / 6.0)
        }
    }
}
