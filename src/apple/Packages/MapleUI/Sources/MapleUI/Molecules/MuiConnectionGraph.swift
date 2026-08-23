// MuiConnectionGraph.swift — Maple UI Molecules-L1 (unified-component-
// catalog.md §2.6; a plot primitive). A static (force-free) node-link
// graph, drawn via SwiftUI `Canvas`: the caller supplies each node's
// normalized `0...1` position directly (or falls back to
// `MuiConnectionGraphMath.circularLayout` — see that type's doc comment)
// — this component only draws links, node circles, and labels.

import SwiftUI

public struct MuiConnectionGraphNode: Identifiable, Sendable {
    public let id: String
    public let label: String
    /// Normalized `0...1` position within the plot.
    public let x: Double
    public let y: Double

    public init(id: String, label: String, x: Double, y: Double) {
        self.id = id
        self.label = label
        self.x = x
        self.y = y
    }
}

public struct MuiConnectionGraphLink: Sendable {
    public let source: String
    public let target: String

    public init(source: String, target: String) {
        self.source = source
        self.target = target
    }
}

public struct MuiConnectionGraph: View {
    public let nodes: [MuiConnectionGraphNode]
    public let links: [MuiConnectionGraphLink]
    public let width: CGFloat
    public let height: CGFloat
    public let showLabels: Bool

    public init(
        nodes: [MuiConnectionGraphNode],
        links: [MuiConnectionGraphLink],
        width: CGFloat = 160,
        height: CGFloat = 96,
        showLabels: Bool = true
    ) {
        self.nodes = nodes
        self.links = links
        self.width = width
        self.height = height
        self.showLabels = showLabels
    }

    public var body: some View {
        Canvas { context, size in
            let nodesById = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0) })
            func toPx(_ node: MuiConnectionGraphNode) -> CGPoint {
                MuiConnectionGraphMath.canvasPoint(x: node.x, y: node.y, width: size.width, height: size.height)
            }

            var linkPath = Path()
            for link in links {
                guard let source = nodesById[link.source], let target = nodesById[link.target] else { continue }
                linkPath.move(to: toPx(source))
                linkPath.addLine(to: toPx(target))
            }
            context.stroke(linkPath, with: .color(MuiTokens.border), lineWidth: 1.5)

            for node in nodes {
                let p = toPx(node)
                let dot = Path(ellipseIn: CGRect(x: p.x - 5, y: p.y - 5, width: 10, height: 10))
                context.fill(dot, with: .color(MuiTokens.primary))

                if showLabels {
                    let text = Text(node.label).font(MuiTokens.TypeScale.font(.toolLabel)).foregroundColor(MuiTokens.textMain)
                    context.draw(text, at: CGPoint(x: p.x, y: p.y + 10), anchor: .top)
                }
            }
        }
        .frame(width: width, height: height)
        .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Connection graph, \(nodes.count) nodes")
    }
}

#Preview("MuiConnectionGraph") {
    let layout = MuiConnectionGraphMath.circularLayout(nodeCount: 5)
    let nodes = layout.enumerated().map { index, position in
        MuiConnectionGraphNode(id: "n\(index)", label: "N\(index)", x: position.x, y: position.y)
    }
    return MuiConnectionGraph(
        nodes: nodes,
        links: [
            MuiConnectionGraphLink(source: "n0", target: "n1"),
            MuiConnectionGraphLink(source: "n1", target: "n2"),
            MuiConnectionGraphLink(source: "n2", target: "n3"),
            MuiConnectionGraphLink(source: "n3", target: "n4"),
            MuiConnectionGraphLink(source: "n4", target: "n0"),
        ]
    )
    .padding()
    .background(MuiTokens.bg)
}
