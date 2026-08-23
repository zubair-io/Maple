// MuiHistogram.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.6; a plot primitive). RGB distribution plot, drawn directly via
// SwiftUI `Canvas`. R/G/B channel colors are literal, not design tokens —
// same "content-functional, not chrome color" precedent as the web
// reference's histogram: a histogram's red/green/blue bars ARE the channel
// identity, independent of the app's accent color. Bars are peak-relative
// (every bin's height is relative to the tallest bin across all three
// channels) with no lane gap — channels overlay each other, unlike Parade's
// side-by-side lanes.

import SwiftUI

public struct MuiHistogram: View {
    /// Pre-binned per-channel counts (e.g. from `MuiHistogramMath.bin`).
    public let r: [Int]
    public let g: [Int]
    public let b: [Int]
    public let width: CGFloat
    public let height: CGFloat

    public init(r: [Int], g: [Int], b: [Int], width: CGFloat = 240, height: CGFloat = 64) {
        self.r = r
        self.g = g
        self.b = b
        self.width = width
        self.height = height
    }

    /// Convenience initializer over raw `0...1` samples, binned internally
    /// via `MuiHistogramMath.bin` — the shape the gallery's fixed sample
    /// data and most real callers (a decoded image's per-channel values)
    /// actually have, rather than pre-binned counts.
    public init(rSamples: [Double], gSamples: [Double], bSamples: [Double], binCount: Int = 64, width: CGFloat = 240, height: CGFloat = 64) {
        self.init(
            r: MuiHistogramMath.bin(rSamples, binCount: binCount),
            g: MuiHistogramMath.bin(gSamples, binCount: binCount),
            b: MuiHistogramMath.bin(bSamples, binCount: binCount),
            width: width,
            height: height
        )
    }

    private static let channelColor = (
        r: Color(red: 220 / 255, green: 80 / 255, blue: 80 / 255).opacity(0.6),
        g: Color(red: 80 / 255, green: 190 / 255, blue: 80 / 255).opacity(0.6),
        b: Color(red: 80 / 255, green: 130 / 255, blue: 220 / 255).opacity(0.6)
    )

    public var body: some View {
        Canvas { context, size in
            let peak = Double([r.max() ?? 1, g.max() ?? 1, b.max() ?? 1].max() ?? 1)
            draw(channel: r, color: Self.channelColor.r, peak: peak, context: context, size: size)
            draw(channel: g, color: Self.channelColor.g, peak: peak, context: context, size: size)
            draw(channel: b, color: Self.channelColor.b, peak: peak, context: context, size: size)
        }
        .frame(width: width, height: height)
        .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Histogram")
    }

    private func draw(channel: [Int], color: Color, peak: Double, context: GraphicsContext, size: CGSize) {
        guard !channel.isEmpty, peak > 0 else { return }
        let colWidth = size.width / CGFloat(channel.count)
        for (index, value) in channel.enumerated() {
            let barHeight = CGFloat(Double(value) / peak) * (size.height - 2)
            let rect = CGRect(x: CGFloat(index) * colWidth, y: size.height - barHeight, width: Swift.max(1, colWidth - 0.5), height: barHeight)
            context.fill(Path(rect), with: .color(color))
        }
    }
}

#Preview("MuiHistogram") {
    MuiHistogram(r: (0..<64).map { $0 }, g: (0..<64).map { 64 - $0 }, b: (0..<64).map { i in 32 - abs(32 - i) })
        .padding()
        .background(MuiTokens.bg)
}
