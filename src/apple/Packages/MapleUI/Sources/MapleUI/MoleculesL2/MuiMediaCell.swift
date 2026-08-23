// MuiMediaCell.swift — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Thumbnail with badges, rating, selection, and a rename-in-place
// affordance — built from Image, Badge, Rating & Flags, Inline Rename
// Field. The core grid-cell primitive Filmstrip Row/Rail compose.

import SwiftUI

public enum MuiMediaCellSize: Sendable {
    case sm, md
}

public struct MuiMediaCell: View {
    public let url: URL?
    public let alt: String
    @Binding public var filename: String
    /// Short text badges (media type, RAW, …) rendered over the thumbnail.
    public let badges: [String]
    public let selected: Bool
    public let size: MuiMediaCellSize
    @Binding public var rating: Int
    @Binding public var flag: MuiRatingFlagState
    /// Fires on a tap of the thumbnail itself — not the rename field or the
    /// rating row, which own their own interactions. The caller decides
    /// what a press means (select, open, toggle).
    public let pressed: (() -> Void)?
    public let renamed: ((String) -> Void)?

    public init(
        url: URL?,
        alt: String,
        filename: Binding<String>,
        badges: [String] = [],
        selected: Bool = false,
        size: MuiMediaCellSize = .md,
        rating: Binding<Int> = .constant(0),
        flag: Binding<MuiRatingFlagState> = .constant(.none),
        pressed: (() -> Void)? = nil,
        renamed: ((String) -> Void)? = nil
    ) {
        self.url = url
        self.alt = alt
        self._filename = filename
        self.badges = badges
        self.selected = selected
        self.size = size
        self._rating = rating
        self._flag = flag
        self.pressed = pressed
        self.renamed = renamed
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
            Button {
                pressed?()
            } label: {
                ZStack(alignment: .topLeading) {
                    MuiImage(url: url, alt: alt, fit: .fill, radius: .sm, aspectRatio: 1)
                    if !badges.isEmpty {
                        HStack(spacing: 2) {
                            ForEach(badges, id: \.self) { badge in
                                MuiBadge(variant: .count, value: badge)
                            }
                        }
                        .padding(4)
                    }
                }
                .overlay(
                    RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous)
                        .stroke(selected ? MuiTokens.primary : .clear, lineWidth: 2)
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(alt)
            .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)

            MuiInlineRenameField(value: $filename, accessibilityLabel: "Rename \(filename)", renamed: renamed)
            MuiRatingFlags(rating: $rating, flag: $flag)
        }
        .frame(width: size == .sm ? 96 : 140)
    }
}

#Preview("MuiMediaCell") {
    struct Demo: View {
        @State private var filename = "IMG_0042.dng"
        @State private var rating = 3
        @State private var flag: MuiRatingFlagState = .pick

        var body: some View {
            HStack(alignment: .top, spacing: 16) {
                MuiMediaCell(url: nil, alt: "Sunset over the fjord", filename: $filename, badges: ["RAW"], selected: true, rating: $rating, flag: $flag)
                MuiMediaCell(url: nil, alt: "Portrait", filename: .constant("IMG_0043.jpg"), size: .sm)
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
