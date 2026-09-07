// MuiVectorscope.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.6; a plot primitive). A chroma scatter plot on a circular graticule:
// each RGB sample converts to BT.601 Cb/Cr and plots as a dot (see
// `MuiVectorscopeMath`). The rim carries a hue ring so a direction on the
// plot reads as a colour without counting spokes; spokes use the border
// token, target dots their own hue, and plotted chroma the accent token.

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

            drawHueRing(context: &context, center: center, radius: radius)

            // Spokes are dashed so they read as a measurement graticule
            // rather than as plotted data — at HUD size a solid spoke and a
            // thin chroma trace are the same handful of pixels.
            var spokes = Path()
            for target in VectorscopeTarget.allCases {
                let angle = (MuiVectorscopeMath.targetAngleDeg(target) + rotationDeg) * .pi / 180
                spokes.move(to: center)
                spokes.addLine(to: CGPoint(x: center.x + cos(angle) * radius, y: center.y - sin(angle) * radius))
            }
            context.stroke(
                spokes, with: .color(MuiTokens.border.opacity(0.55)),
                style: StrokeStyle(lineWidth: 0.5, dash: [2, 3]))

            // Target dots sit ON the hue ring, each in its own colour — the
            // ring says "this direction is this hue" and the dot says
            // "this exact angle is the broadcast target for it".
            for target in VectorscopeTarget.allCases {
                let angle = (MuiVectorscopeMath.targetAngleDeg(target) + rotationDeg) * .pi / 180
                let p = CGPoint(x: center.x + cos(angle) * radius, y: center.y - sin(angle) * radius)
                let rgb = MuiVectorscopeMath.targetRGB(target)
                context.fill(
                    Path(ellipseIn: CGRect(x: p.x - 3.5, y: p.y - 3.5, width: 7, height: 7)),
                    with: .color(Color(red: rgb.r, green: rgb.g, blue: rgb.b)))
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

    /// The skin-tone range: a filled cone over the +/-10 degree tolerance
    /// band, its centre line, and a person glyph on the ring marking which
    /// direction "skin" is. Filled rather than two bare edge lines (the
    /// pre-#3350 draw) because the band is the thing being read — the user
    /// drags Hue until the chroma cloud sits inside this cone, and a filled
    /// region shows in/out at a glance where two hairlines did not.
    private func drawSkinToneLine(context: inout GraphicsContext, center: CGPoint, radius: CGFloat) {
        let centreAngle = MuiVectorscopeMath.skinToneLineAngleDeg + rotationDeg
        let wedge = MuiVectorscopeMath.skinToneLineWedgeDeg
        let lo = (centreAngle - wedge) * .pi / 180
        let hi = (centreAngle + wedge) * .pi / 180

        var cone = Path()
        cone.move(to: center)
        cone.addLine(to: CGPoint(x: center.x + cos(lo) * radius, y: center.y - sin(lo) * radius))
        cone.addLine(to: CGPoint(x: center.x + cos(hi) * radius, y: center.y - sin(hi) * radius))
        cone.closeSubpath()
        context.fill(cone, with: .color(.white.opacity(0.16)))
        context.stroke(cone, with: .color(.white.opacity(0.30)), lineWidth: 0.5)

        var line = Path()
        let rad = centreAngle * .pi / 180
        line.move(to: center)
        line.addLine(to: CGPoint(x: center.x + cos(rad) * radius, y: center.y - sin(rad) * radius))
        context.stroke(line, with: .color(.white.opacity(0.75)), lineWidth: 1)

        // Person glyph at the skin-tone angle — the legend for the cone, so
        // the band needs no separate caption. Placed just INSIDE the rim:
        // the Canvas frame is only `radius + 4`, so drawing it outside the
        // ring (where a full-size scope would put it) clips it away.
        // `.resizable()` (not `.font`, which yields a View the context
        // cannot resolve) so the glyph scales with the HUD's size.
        var glyph = context.resolve(
            Image(systemName: "person").resizable().symbolRenderingMode(.monochrome))
        glyph.shading = .color(.white.opacity(0.85))
        let box = Swift.max(9, radius * 0.20)
        let inset = radius - box * 0.75
        let at = CGPoint(x: center.x + cos(rad) * inset, y: center.y - sin(rad) * inset)
        context.draw(
            glyph, in: CGRect(x: at.x - box / 2, y: at.y - box / 2, width: box, height: box))
    }

    /// The continuous hue ring around the rim. Drawn as short arc segments
    /// rather than a SwiftUI `AngularGradient` so the colour at every angle
    /// comes from the SAME Rec.709 target math the dots and the plotted
    /// chroma use — a gradient would interpolate over a uniform hexagon and
    /// drift against the real, non-uniformly spaced targets.
    private func drawHueRing(context: inout GraphicsContext, center: CGPoint, radius: CGFloat) {
        let step = 2.0
        let width = Swift.max(2.0, radius * 0.06)
        var a = 0.0
        while a < 360 {
            let rgb = MuiVectorscopeMath.ringRGB(atAngleDeg: a)
            var arc = Path()
            // Canvas y grows down while graticule angles grow counter-
            // clockwise, so the sweep is negated to match the dots.
            arc.addArc(
                center: center, radius: radius,
                startAngle: .degrees(-(a + rotationDeg)),
                endAngle: .degrees(-(a + step + rotationDeg)),
                clockwise: true)
            context.stroke(
                arc, with: .color(Color(red: rgb.r, green: rgb.g, blue: rgb.b)),
                lineWidth: width)
            a += step
        }
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
                // most-positive cr (matches `canvasPoint`'s cr-grows-up,
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
