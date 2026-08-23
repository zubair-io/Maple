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

    public init(samples: [MuiVectorscopeSample], size: CGFloat = 96, dotColor: Color = MuiTokens.primary) {
        self.samples = samples
        self.size = size
        self.dotColor = dotColor
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

            for sample in samples {
                let chroma = MuiVectorscopeMath.chroma(r: sample.r, g: sample.g, b: sample.b)
                let point = MuiVectorscopeMath.canvasPoint(cb: chroma.cb, cr: chroma.cr, center: center, radius: radius)
                let dot = Path(ellipseIn: CGRect(x: point.x - 1.5, y: point.y - 1.5, width: 3, height: 3))
                context.fill(dot, with: .color(dotColor))
            }
        }
        .frame(width: size, height: size)
        .background(MuiTokens.imageCanvas, in: Circle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Vectorscope")
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
