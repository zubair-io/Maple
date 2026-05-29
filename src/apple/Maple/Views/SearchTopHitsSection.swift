// SearchTopHitsSection.swift — top-hits row for S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md §2 "TOP HITS".
//
// Up to 3 mixed-kind hits with a 36pt thumb, label (with the matched
// query token highlighted in MapleTokens.primary 600-weight), optional
// sub-label, and a small kind tag (PLACE / ALBUM / KEYWORD / PERSON).
//
// v0.1 derives the hits from the head of the photo result list, so
// every hit is `kind: .photo` — no kind tag, no kind-specific routing.
// When a dedicated /api/search/tophits endpoint lands the row supplier
// changes; the renderer here doesn't.

#if os(iOS)

import SwiftUI
import MapleCore

/// Top-hit kind union. Mirrors the web `TopHitKind`.
enum SearchTopHitKind {
    case photo, place, album, keyword, person

    var tag: String? {
        switch self {
        case .photo: nil
        case .place: "PLACE"
        case .album: "ALBUM"
        case .keyword: "KEYWORD"
        case .person: "PERSON"
        }
    }
}

/// Renderable top-hit row. Source data lives outside this struct so the
/// renderer can stay swap-friendly (photos today, mixed-kind tomorrow).
struct SearchTopHit: Identifiable, Hashable {
    let id: String
    let kind: SearchTopHitKind
    let label: String
    let subLabel: String?
    /// Asset id (for `.photo` hits) so the host can route to the editor
    /// without the renderer importing routing types.
    let assetID: String?
}

struct SearchTopHitsSection: View {
    let hits: [SearchTopHit]
    let query: String
    let onTap: (SearchTopHit) -> Void

    var body: some View {
        if hits.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("TOP HITS")
                    .font(.custom("Lato-Bold", size: 10))
                    .tracking(0.6)
                    .foregroundStyle(MapleTokens.textMuted)

                VStack(spacing: 4) {
                    ForEach(hits) { hit in
                        row(for: hit)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func row(for hit: SearchTopHit) -> some View {
        Button {
            onTap(hit)
        } label: {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(MapleTokens.surfaceAlt)
                    .frame(width: 36, height: 36)
                    .overlay(
                        Image(systemName: hit.kind == .photo ? "photo" : "tag")
                            .font(.system(size: 14))
                            .foregroundStyle(MapleTokens.textMuted)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    highlightedLabel(hit.label, query: query)
                        .font(.custom("Lato-Regular", size: 14))
                        .lineLimit(1)
                    if let sub = hit.subLabel {
                        Text(sub)
                            .font(.custom("Lato-Regular", size: 11))
                            .foregroundStyle(MapleTokens.textMuted)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let tag = hit.kind.tag {
                    Text(tag)
                        .font(.custom("Lato-Bold", size: 9))
                        .tracking(0.7)
                        .foregroundStyle(MapleTokens.textMuted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .overlay(
                            RoundedRectangle(cornerRadius: 4, style: .continuous)
                                .stroke(MapleTokens.border, lineWidth: 0.5)
                        )
                }
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("top-hit-\(hit.id)")
    }

    /// Highlight occurrences of each whitespace-separated token from `query`
    /// in the label, wrapping matched runs in MapleTokens.primary
    /// semibold. Case-insensitive.
    private func highlightedLabel(_ label: String, query: String) -> Text {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return Text(label) }
        let tokens = trimmed
            .split(separator: " ")
            .map { $0.lowercased() }
            .filter { !$0.isEmpty }
        guard !tokens.isEmpty else { return Text(label) }

        var result = Text("")
        var cursor = label.startIndex
        let lower = label.lowercased()

        while cursor < label.endIndex {
            // Find earliest token match from cursor.
            var bestStart: String.Index? = nil
            var bestEnd: String.Index? = nil
            for token in tokens {
                if let range = lower.range(of: token, range: cursor..<label.endIndex) {
                    if bestStart == nil || range.lowerBound < bestStart! {
                        bestStart = range.lowerBound
                        bestEnd = range.upperBound
                    }
                }
            }
            guard let s = bestStart, let e = bestEnd else {
                result = result + Text(label[cursor...])
                break
            }
            if s > cursor {
                result = result + Text(label[cursor..<s])
            }
            result = result + Text(label[s..<e])
                .foregroundColor(MapleTokens.primary)
                .fontWeight(.semibold)
            cursor = e
        }
        return result
    }
}

#Preview("TopHits — sample photos") {
    SearchTopHitsSection(
        hits: [
            SearchTopHit(id: "1", kind: .photo, label: "paris-rooftop.dng",
                         subLabel: "Hasselblad L3D-100c", assetID: "1"),
            SearchTopHit(id: "2", kind: .photo, label: "paris-night.dng",
                         subLabel: "Hasselblad L3D-100c", assetID: "2"),
        ],
        query: "paris",
        onTap: { _ in }
    )
    .padding()
    .background(MapleTokens.bg)
}

#endif
