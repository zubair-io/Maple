// MuiParade.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.6; a plot primitive). Three side-by-side per-channel waveforms, drawn
// via SwiftUI `Canvas`. Like Histogram, the R/G/B colors are literal
// channel identity, not design tokens. Per-lane `0...1` clamp, gapped
// lanes — each channel gets its own side-by-side lane, unlike Histogram's
// shared/overlapping bars.

import SwiftUI

public struct MuiParade: View {
    /// Per-column samples, one array per channel, each value `0...1`.
    public let r: [Double]
    public let g: [Double]
    public let b: [Double]
    public let width: CGFloat
    public let height: CGFloat

    public init(r: [Double], g: [Double], b: [Double], width: CGFloat = 240, height: CGFloat = 64) {
        self.r = r
        self.g = g
        self.b = b
        self.width = width
        self.height = height
    }

    private static let channelColor = (
        r: Color(red: 220 / 255, green: 80 / 255, blue: 80 / 255).opacity(0.85),
        g: Color(red: 80 / 255, green: 190 / 255, blue: 80 / 255).opacity(0.85),
        b: Color(red: 80 / 255, green: 130 / 255, blue: 220 / 255).opacity(0.85)
    )

    private static let gapPx: CGFloat = 4

    public var body: some View {
        Canvas { context, size in
            let channels = [(r, Self.channelColor.r), (g, Self.channelColor.g), (b, Self.channelColor.b)]
            let laneWidth = (size.width - Self.gapPx * CGFloat(channels.count - 1)) / CGFloat(channels.count)
            for (laneIndex, channel) in channels.enumerated() {
                let laneX = CGFloat(laneIndex) * (laneWidth + Self.gapPx)
                draw(values: channel.0, color: channel.1, originX: laneX, laneWidth: laneWidth, context: context, size: size)
            }
        }
        .frame(width: width, height: height)
        .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Parade")
    }

    private func draw(values: [Double], color: Color, originX: CGFloat, laneWidth: CGFloat, context: GraphicsContext, size: CGSize) {
        guard !values.isEmpty else { return }
        let colWidth = laneWidth / CGFloat(values.count)
        for (index, value) in values.enumerated() {
            let barHeight = MuiCurvePlotMath.clampUnit(value) * Double(size.height - 2)
            let rect = CGRect(
                x: originX + CGFloat(index) * colWidth,
                y: size.height - CGFloat(barHeight),
                width: Swift.max(1, colWidth - 0.5),
                height: CGFloat(barHeight)
            )
            context.fill(Path(rect), with: .color(color))
        }
    }
}

#Preview("MuiParade") {
    MuiParade(
        r: (0..<40).map { 0.5 + 0.4 * sin(Double($0) / 4) },
        g: (0..<40).map { 0.5 + 0.3 * cos(Double($0) / 5) },
        b: (0..<40).map { 0.4 + 0.3 * sin(Double($0) / 3) }
    )
    .padding()
    .background(MuiTokens.bg)
}
