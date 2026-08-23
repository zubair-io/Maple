// MuiInfoPanel.swift — Maple UI Organisms · Inspectors & panels
// (unified-component-catalog.md §4.3). Full asset metadata, built from
// Label-Value Grid, Histogram, Keyword Row, Rating & Flags, Inline Rename
// Field. `loading` gates the whole body behind a centered Spinner.
// `metadata` always renders — Label-Value Grid already handles an empty
// array gracefully — so there's no separate metadata-empty state to build.

import SwiftUI

public struct MuiInfoPanelHistogram: Sendable {
    public let r: [Int]
    public let g: [Int]
    public let b: [Int]

    public init(r: [Int], g: [Int], b: [Int]) {
        self.r = r
        self.g = g
        self.b = b
    }
}

public struct MuiInfoPanel: View {
    public let loading: Bool
    @Binding public var filename: String
    public let metadata: [MuiLabelValueRow]
    public let histogram: MuiInfoPanelHistogram?
    public let keywords: [MuiChip]
    @Binding public var rating: Int
    @Binding public var flag: MuiRatingFlagState
    public let renamed: ((String) -> Void)?
    public let keywordAdded: ((String) -> Void)?
    public let keywordRemoved: ((String) -> Void)?

    public init(
        loading: Bool = false,
        filename: Binding<String>,
        metadata: [MuiLabelValueRow],
        histogram: MuiInfoPanelHistogram? = nil,
        keywords: [MuiChip],
        rating: Binding<Int> = .constant(0),
        flag: Binding<MuiRatingFlagState> = .constant(.none),
        renamed: ((String) -> Void)? = nil,
        keywordAdded: ((String) -> Void)? = nil,
        keywordRemoved: ((String) -> Void)? = nil
    ) {
        self.loading = loading
        self._filename = filename
        self.metadata = metadata
        self.histogram = histogram
        self.keywords = keywords
        self._rating = rating
        self._flag = flag
        self.renamed = renamed
        self.keywordAdded = keywordAdded
        self.keywordRemoved = keywordRemoved
    }

    public var body: some View {
        Group {
            if loading {
                MuiSpinner(placement: .centered, label: "Loading metadata")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
                        MuiInlineRenameField(value: $filename, accessibilityLabel: "Filename", renamed: renamed)

                        if let histogram {
                            MuiHistogram(r: histogram.r, g: histogram.g, b: histogram.b)
                        }

                        MuiRatingFlags(rating: $rating, flag: $flag)

                        MuiKeywordRow(keywords: keywords, removed: keywordRemoved, added: keywordAdded)

                        MuiLabelValueGrid(rows: metadata)
                    }
                    .padding(MuiTokens.spacingMd)
                }
            }
        }
    }
}

#Preview("MuiInfoPanel — Populated") {
    struct Demo: View {
        @State private var filename = "IMG_0042.dng"
        @State private var rating = 4
        @State private var flag: MuiRatingFlagState = .pick
        var body: some View {
            MuiInfoPanel(
                filename: $filename,
                metadata: [
                    MuiLabelValueRow(label: "Camera", value: "Sony A7 IV"),
                    MuiLabelValueRow(label: "Lens", value: "24-70mm f/2.8"),
                    MuiLabelValueRow(label: "ISO", value: "400"),
                ],
                histogram: MuiInfoPanelHistogram(r: (0..<32).map { $0 * 3 }, g: (0..<32).map { $0 * 2 }, b: (0..<32).map { 64 - $0 }),
                keywords: [MuiChip(id: "1", label: "Sunset"), MuiChip(id: "2", label: "Landscape")],
                rating: $rating,
                flag: $flag
            )
            .frame(width: 280, height: 480)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}

#Preview("MuiInfoPanel — Loading") {
    MuiInfoPanel(filename: .constant(""), metadata: [], keywords: [])
        .frame(width: 280, height: 200)
        .background(MuiTokens.bg)
}
