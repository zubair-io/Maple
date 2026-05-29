// FilterChipRow.swift — responsive-program S2 (#623). Single-select chip
// row over the Library grid: All / Picks / 4+ stars / Edited.
//
// Spec: docs/design/responsive-program/s2-library-grid.md §2 (Phone) and
// §4 (Web mirror). Active chip = `MapleTokens.primary` 22% fill +
// `MapleTokens.primary` border + `MapleTokens.primary` text. Idle chip =
// `MapleTokens.surfaceAlt` fill + `MapleTokens.border` border +
// `MapleTokens.textMuted` text. Hit area ≥28pt tall (chip visual ~22pt,
// transparently padded).
//
// Filter values are the string literals persisted to `@AppStorage("cm.filter")`
// — mirroring the web `CullFilter` type so phone-set preferences round-trip
// through localStorage when the same user opens the web app:
//   "all" (default) · "picks" · "4stars" · "edited"

import SwiftUI

/// Canonical filter values. Pure-data so it's trivially exercised from
/// the filter unit tests (`LibraryGridFilterTests`).
enum LibraryFilter: String, CaseIterable, Sendable, Equatable {
    case all
    case picks
    case fourStars = "4stars"
    case edited

    var label: String {
        switch self {
        case .all:       return "All"
        case .picks:     return "Picks"
        case .fourStars: return "4+ stars"
        case .edited:    return "Edited"
        }
    }
}

struct FilterChipRow: View {
    @Binding var active: String

    var body: some View {
        HStack(spacing: 8) {
            ForEach(LibraryFilter.allCases, id: \.rawValue) { f in
                chip(filter: f, isActive: active == f.rawValue)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .accessibilityIdentifier("library-filter-chip-row")
    }

    @ViewBuilder
    private func chip(filter: LibraryFilter, isActive: Bool) -> some View {
        Button {
            // Cross-fade content per spec via the S0a motion token.
            withAnimation(MapleTokens.Motion.filterFade) {
                active = filter.rawValue
            }
        } label: {
            Text(filter.label)
                .font(MapleTokens.Typography.chipLabel)
                .foregroundStyle(isActive ? MapleTokens.primary : MapleTokens.textMuted)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(
                    Capsule()
                        .fill(isActive
                              ? MapleTokens.primary.opacity(0.22)
                              : MapleTokens.surfaceAlt)
                )
                .overlay(
                    Capsule()
                        .stroke(isActive ? MapleTokens.primary : MapleTokens.border,
                                lineWidth: 0.5)
                )
                // Transparent vertical padding gives a ≥28pt tap target while
                // keeping the chip visual at the spec'd ~22pt height.
                .contentShape(Capsule())
                .padding(.vertical, 3)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("library-filter-chip-\(filter.rawValue)")
        .accessibilityLabel(filter.label)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}

#Preview("All active") {
    StatefulPreview()
        .padding()
        .background(MapleTokens.bg)
}

private struct StatefulPreview: View {
    @State var v: String = "all"
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            FilterChipRow(active: $v)
            Text("active = \(v)")
                .font(MapleTokens.Typography.body)
                .foregroundStyle(MapleTokens.textMuted)
        }
    }
}
