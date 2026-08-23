// MuiList.swift — Maple UI List atom.
// Contract: docs/design/maple-ui/components/list.md
//
// Distinct from the List Row molecule: this atom renders bare text items
// with a marker, not rows with icons/timestamps/inline actions.

import SwiftUI

/// One item of a `MuiList`. `children` nests a full sub-list one level
/// deeper, so nesting is a real recursive structure (list.md §Variants).
public struct MuiListItem: Identifiable, Hashable, Sendable {
    public let id: UUID
    public let text: String
    public let children: [MuiListItem]?

    public init(id: UUID = UUID(), text: String, children: [MuiListItem]? = nil) {
        self.id = id
        self.text = text
        self.children = children
    }
}

public enum MuiListMarker: Sendable {
    case disc, dash, none
}

public enum MuiListDensity: Sendable {
    case compact, comfortable
}

/// Ordered or unordered plain-text items (list.md §Purpose).
///
/// SwiftUI has no bare `<ul>`/`<ol>` primitive outside the heavyweight,
/// scrollable `List` component, which is the wrong fit for an inline
/// atom — this renders a recursive `VStack` of marker + text instead, and
/// groups the whole tree into one accessibility element so assistive
/// technology doesn't have to traverse every marker glyph individually.
public struct MuiList: View {
    public let items: [MuiListItem]
    public let ordered: Bool
    public let marker: MuiListMarker
    public let density: MuiListDensity

    public init(
        items: [MuiListItem],
        ordered: Bool = false,
        marker: MuiListMarker = .disc,
        density: MuiListDensity = .comfortable
    ) {
        self.items = items
        self.ordered = ordered
        self.marker = marker
        self.density = density
    }

    public var body: some View {
        MuiListLevel(items: items, ordered: ordered, marker: marker, density: density)
            .accessibilityElement(children: .combine)
    }
}

private struct MuiListLevel: View {
    let items: [MuiListItem]
    let ordered: Bool
    let marker: MuiListMarker
    let density: MuiListDensity

    var body: some View {
        VStack(alignment: .leading, spacing: rowSpacing) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                    HStack(alignment: .firstTextBaseline, spacing: MuiTokens.spacingXs) {
                        markerView(index: index)
                        Text(item.text)
                            .font(MuiTokens.TypeScale.font(.body))
                            .foregroundStyle(MuiTokens.textMain)
                    }
                    if let children = item.children, !children.isEmpty {
                        MuiListLevel(items: children, ordered: ordered, marker: marker, density: density)
                            .padding(.leading, MuiTokens.spacingMd)
                    }
                }
            }
        }
    }

    private var rowSpacing: CGFloat {
        density == .compact ? MuiTokens.spacingXs : MuiTokens.spacingSm
    }

    @ViewBuilder
    private func markerView(index: Int) -> some View {
        if ordered {
            Text("\(index + 1).")
                .font(MuiTokens.TypeScale.font(.body))
                .foregroundStyle(MuiTokens.textMuted)
        } else {
            switch marker {
            case .disc:
                Text("•")
                    .font(MuiTokens.TypeScale.font(.body))
                    .foregroundStyle(MuiTokens.textMain)
            case .dash:
                Text("–")
                    .font(MuiTokens.TypeScale.font(.body))
                    .foregroundStyle(MuiTokens.textMuted)
            case .none:
                EmptyView()
            }
        }
    }
}

#Preview("MuiList — Unordered, nested") {
    MuiList(items: [
        MuiListItem(text: "Import"),
        MuiListItem(text: "Cull", children: [
            MuiListItem(text: "Flag picks"),
            MuiListItem(text: "Reject blur"),
        ]),
        MuiListItem(text: "Export"),
    ])
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiList — Ordered, compact") {
    MuiList(
        items: [
            MuiListItem(text: "Connect a source"),
            MuiListItem(text: "Choose a folder"),
            MuiListItem(text: "Start the import"),
        ],
        ordered: true,
        density: .compact
    )
    .padding()
    .background(MuiTokens.bg)
}
