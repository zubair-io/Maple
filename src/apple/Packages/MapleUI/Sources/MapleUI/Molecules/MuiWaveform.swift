// MuiWaveform.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.6; a plot primitive). A single-channel luma column plot, drawn via
// SwiftUI `Canvas`. Unlike Histogram/Parade's literal RGB channel colors,
// a luma waveform has no inherent color of its own, so it defaults to the
// design system's own accent token.

import SwiftUI

public struct MuiWaveform: View {
    /// Per-column luma samples, `0...1`.
    public let luma: [Double]
    public let width: CGFloat
    public let height: CGFloat
    public let color: Color

    public init(luma: [Double], width: CGFloat = 240, height: CGFloat = 64, color: Color = MuiTokens.primary) {
        self.luma = luma
        self.width = width
        self.height = height
        self.color = color
    }

    public var body: some View {
        Canvas { context, size in
            guard !luma.isEmpty else { return }
            let colWidth = size.width / CGFloat(luma.count)
            for (index, sample) in luma.enumerated() {
                let barHeight = MuiCurvePlotMath.clampUnit(sample) * Double(size.height - 2)
                let rect = CGRect(
                    x: CGFloat(index) * colWidth,
                    y: size.height - CGFloat(barHeight),
                    width: Swift.max(1, colWidth - 0.5),
                    height: CGFloat(barHeight)
                )
                context.fill(Path(rect), with: .color(color))
            }
        }
        .frame(width: width, height: height)
        .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Waveform")
    }
}

#Preview("MuiWaveform") {
    MuiWaveform(luma: (0..<80).map { 0.5 + 0.4 * sin(Double($0) / 6) })
        .padding()
        .background(MuiTokens.bg)
}
