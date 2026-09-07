// MuiVectorscope.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.6; a plot primitive). A chroma scatter plot on a circular graticule:
// each RGB sample converts to BT.601 Cb/Cr and plots as a dot (see
// `MuiVectorscopeMath`). Chrome (circle, spokes) uses the border token;
// dots use the accent token.

import SwiftUI

public struct MuiVectorscopeSample: Sendable {
    public let r: Double
    public let g: Double
    public let b: Double

    public init(r: Double, g: Double, b: Double) {
        self.r = r
        self.g = g
        self.b = b
    }
}

public struct MuiVectorscope: View {
    public let samples: [MuiVectorscopeSample]
    public let size: CGFloat
    public let dotColor: Color
    /// Row-major density bins (spec §3.1's HUD path), `n × n` for any `n`.
    /// `nil` keeps the legacy per-sample dot-scatter draw (the existing
    /// MapleUI gallery call site, and every pre-#3276 call site).
    public let bins: [[UInt32]]?
    /// Draws the broadcast skin-tone line + wedge graticule overlay.
    public let showSkinToneLine: Bool
    /// Rotates the whole plot so the Red target sits at 0° (3 o'clock)
    /// instead of its native ~103° — the convention some broadcast scopes
    /// use, and the one the skin-tone workflow's HUD wants (Task 5).
    public let redAt3OClock: Bool

    public init(
        samples: [MuiVectorscopeSample], size: CGFloat = 96, dotColor: Color = MuiTokens.primary,
        bins: [[UInt32]]? = nil, showSkinToneLine: Bool = false, redAt3OClock: Bool = false
    ) {
        self.samples = samples
        self.size = size
        self.dotColor = dotColor
        self.bins = bins
        self.showSkinToneLine = showSkinToneLine
        self.redAt3OClock = redAt3OClock
    }

    private var rotationDeg: Double {
        redAt3OClock ? -MuiVectorscopeMath.targetAngleDeg(.red) : 0
    }

    public var body: some View {
        Canvas { context, canvasSize in
            let center = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
            let radius = Swift.min(canvasSize.width, canvasSize.height) / 2 - 4

            var chrome = Path()
            chrome.addEllipse(in: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
            for i in 0..<6 {
                let angle = (Double(i) / 6) * Double.pi * 2
                chrome.move(to: center)
                chrome.addLine(to: CGPoint(x: center.x + cos(angle) * radius, y: center.y + sin(angle) * radius))
            }
            context.stroke(chrome, with: .color(MuiTokens.border), lineWidth: 0.5)

            for target in VectorscopeTarget.allCases {
                let angle = (MuiVectorscopeMath.targetAngleDeg(target) + rotationDeg) * .pi / 180
                let p = CGPoint(x: center.x + cos(angle) * radius * 0.82, y: center.y - sin(angle) * radius * 0.82)
                context.fill(Path(ellipseIn: CGRect(x: p.x - 2, y: p.y - 2, width: 4, height: 4)), with: .color(MuiTokens.textMuted))
            }

            if showSkinToneLine {
                drawSkinToneLine(context: &context, center: center, radius: radius)
            }

            if let bins {
                drawDensity(bins, context: &context, center: center, radius: radius)
            } else {
                for sample in samples {
                    let chroma = MuiVectorscopeMath.chroma(r: sample.r, g: sample.g, b: sample.b)
                    let point = MuiVectorscopeMath.canvasPoint(cb: chroma.cb, cr: chroma.cr, center: center, radius: radius)
                    context.fill(Path(ellipseIn: CGRect(x: point.x - 1.5, y: point.y - 1.5, width: 3, height: 3)), with: .color(dotColor))
                }
            }
        }
        .frame(width: size, height: size)
        .background(MuiTokens.imageCanvas, in: Circle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Vectorscope")
    }

    private func drawSkinToneLine(context: inout GraphicsContext, center: CGPoint, radius: CGFloat) {
        let centreAngle = MuiVectorscopeMath.skinToneLineAngleDeg + rotationDeg
        let wedge = MuiVectorscopeMath.skinToneLineWedgeDeg
        var wedgePath = Path()
        for a in [centreAngle - wedge, centreAngle + wedge] {
            let rad = a * .pi / 180
            wedgePath.move(to: center)
            wedgePath.addLine(to: CGPoint(x: center.x + cos(rad) * radius, y: center.y - sin(rad) * radius))
        }
        context.stroke(wedgePath, with: .color(.yellow.opacity(0.25)), lineWidth: 1)
        var line = Path()
        let rad = centreAngle * .pi / 180
        line.move(to: center)
        line.addLine(to: CGPoint(x: center.x + cos(rad) * radius, y: center.y - sin(rad) * radius))
        context.stroke(line, with: .color(.yellow.opacity(0.7)), lineWidth: 1)
    }

    /// Density cells are drawn in log-scaled opacity (`log(1+count) /
    /// log(1+max)`) rather than linear, so a single dominant bin (the grey
    /// axis on most real photos) doesn't crush every other bin down to
    /// invisible — matching how the GPU scope pass's own histogram is
    /// inherently skewed (most weight sits near the achromatic centre).
    private func drawDensity(_ bins: [[UInt32]], context: inout GraphicsContext, center: CGPoint, radius: CGFloat) {
        let n = bins.count
        guard n > 0 else { return }
        let maxCount = bins.lazy.flatMap { $0 }.max() ?? 0
        guard maxCount > 0 else { return }
        let cell = (radius * 2) / CGFloat(n)
        for row in 0..<n {
            for col in 0..<min(n, bins[row].count) where bins[row][col] > 0 {
                let t = log(1 + Double(bins[row][col])) / log(1 + Double(maxCount))
                // Bin (row, col) covers an n×n grid over the SAME [-0.5,
                // 0.5] chroma square `canvasPoint` maps — row 0 is the
                // most-negative cr (matches `canvasPoint`'s cr-grows-up,
                // so the top row is HIGH cr, hence `0.5 - row/n`).
                var (cb, cr) = MuiVectorscopeMath.binCentre(row: row, col: col, n: n)
                if redAt3OClock {
                    (cb, cr) = MuiVectorscopeMath.rotated(cb: cb, cr: cr, by: rotationDeg)
                }
                let p = MuiVectorscopeMath.canvasPoint(cb: cb, cr: cr, center: center, radius: radius)
                context.fill(
                    Path(CGRect(x: p.x - cell / 2, y: p.y - cell / 2, width: cell, height: cell)),
                    with: .color(dotColor.opacity(0.15 + 0.85 * t))
                )
            }
        }
    }
}

#Preview("MuiVectorscope") {
    MuiVectorscope(samples: (0..<200).map { i in
        let t = Double(i) / 200
        return MuiVectorscopeSample(r: 0.5 + 0.4 * sin(t * 12), g: 0.5 + 0.3 * cos(t * 9), b: 0.5 + 0.2 * sin(t * 5))
    })
    .padding()
    .background(MuiTokens.bg)
}
