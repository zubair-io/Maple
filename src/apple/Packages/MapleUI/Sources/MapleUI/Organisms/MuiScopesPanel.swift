// MuiScopesPanel.swift — Maple UI Organisms · Inspectors & panels
// (unified-component-catalog.md §4.3). A pinned four-up stack of the
// live-frame scope plots, always rendered in that fixed order — built
// from Histogram, Waveform, Parade, Vectorscope. There's no loading/empty
// state of its own: a caller with no live frame simply doesn't mount this
// panel; once mounted with a sample (even an all-zero one, a flat
// histogram) it's always in its one populated state.

import SwiftUI

public struct MuiScopeHistogramSample: Sendable {
    public let r: [Int]
    public let g: [Int]
    public let b: [Int]

    public init(r: [Int], g: [Int], b: [Int]) {
        self.r = r
        self.g = g
        self.b = b
    }
}

public struct MuiScopeParadeSample: Sendable {
    public let r: [Double]
    public let g: [Double]
    public let b: [Double]

    public init(r: [Double], g: [Double], b: [Double]) {
        self.r = r
        self.g = g
        self.b = b
    }
}

public struct MuiScopeSample: Sendable {
    public let histogram: MuiScopeHistogramSample
    public let waveformLuma: [Double]
    public let parade: MuiScopeParadeSample
    public let vectorscope: [MuiVectorscopeSample]

    public init(histogram: MuiScopeHistogramSample, waveformLuma: [Double], parade: MuiScopeParadeSample, vectorscope: [MuiVectorscopeSample]) {
        self.histogram = histogram
        self.waveformLuma = waveformLuma
        self.parade = parade
        self.vectorscope = vectorscope
    }
}

public struct MuiScopesPanel: View {
    public let sample: MuiScopeSample
    public let width: CGFloat
    public let height: CGFloat

    public init(sample: MuiScopeSample, width: CGFloat = 200, height: CGFloat = 56) {
        self.sample = sample
        self.width = width
        self.height = height
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            scope("Histogram") {
                MuiHistogram(r: sample.histogram.r, g: sample.histogram.g, b: sample.histogram.b, width: width, height: height)
            }
            scope("Waveform") {
                MuiWaveform(luma: sample.waveformLuma, width: width, height: height)
            }
            scope("Parade") {
                MuiParade(r: sample.parade.r, g: sample.parade.g, b: sample.parade.b, width: width, height: height)
            }
            scope("Vectorscope") {
                MuiVectorscope(samples: sample.vectorscope, size: min(width, height * 2))
            }
        }
        .padding(MuiTokens.spacingMd)
    }

    private func scope(_ label: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            MuiText(label, variant: .toolLabel, color: .muted)
            content()
        }
    }
}

#Preview("MuiScopesPanel") {
    MuiScopesPanel(sample: MuiScopeSample(
        histogram: MuiScopeHistogramSample(r: (0..<32).map { $0 * 3 }, g: (0..<32).map { $0 * 2 }, b: (0..<32).map { 64 - $0 }),
        waveformLuma: (0..<64).map { Double($0) / 64 },
        parade: MuiScopeParadeSample(r: (0..<32).map { Double($0) / 32 }, g: (0..<32).map { Double($0) / 32 * 0.8 }, b: (0..<32).map { Double($0) / 32 * 0.6 }),
        vectorscope: (0..<40).map { i in MuiVectorscopeSample(r: Double(i % 5) / 5, g: Double(i % 3) / 3, b: Double(i % 7) / 7) }
    ))
    .frame(width: 240)
    .background(MuiTokens.bg)
}
