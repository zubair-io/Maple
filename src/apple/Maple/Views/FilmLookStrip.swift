// FilmLookStrip.swift — iPhone (compact-width) look picker for Film (#2794).
//
// `FilmSection`'s vertical look list (a fixed 240pt `ScrollView`) is the
// macOS/iPad shape — plenty of flyout-panel height to spend. On a phone's
// bottom control bar (`MobileControlBar`, `IPhoneLegacyControlBar`) that
// budget doesn't exist: category chips + a 240pt list + the strength
// slider is taller than the whole bar should ever be. This view is the
// compact replacement `FilmSection` swaps in when
// `horizontalSizeClass == .compact` — a horizontally-scrolling row of look
// cards instead of a vertical list, matching the category chip row already
// above it. "None" stays pinned first, same contract as the vertical list's
// pinned None row.
//
// Text-only cards — no per-look thumbnail imagery. Per-look preview art is
// explicitly deferred (ticket #2794 scope note); adding it later is a card
// content swap, not a structural change here.
//
// Reuses the SAME accessibility identifiers as the vertical list
// (`film-look-row-<id>`, `film-look-none`) so `FilmPanelUITests` and any
// other automation that looks up a look by id keep working regardless of
// which layout is on screen.

import MapleCore
import SwiftUI

struct FilmLookStrip: View {
    let looks: [FilmLookEntry]
    let activeLookId: String
    let onSelectLook: (String) -> Void
    let onSelectNone: () -> Void

    private var isLookActive: Bool { !activeLookId.isEmpty }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            // Lazy so switching categories only realizes the cards actually
            // on screen — same pattern as `FilmstripView`'s thumbnail rail.
            LazyHStack(spacing: 6) {
                FilmLookCard(title: "None", isSelected: !isLookActive, action: onSelectNone)
                    .accessibilityIdentifier("film-look-none")
                ForEach(looks, id: \.id) { look in
                    FilmLookCard(
                        title: look.name,
                        isSelected: look.id == activeLookId,
                        action: { onSelectLook(look.id) }
                    )
                    .accessibilityIdentifier("film-look-row-\(look.id)")
                }
            }
            // Mirrors the category chip row's edge padding so neither row's
            // selection ring clips against the scroll edge.
            .padding(.horizontal, 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("film-look-strip")
    }
}

// MARK: - FilmLookCard

/// One card in the strip — the horizontal-layout twin of `FilmLookRow`
/// (`FilmSection.swift`'s vertical list row): same selected-state styling
/// (accent text + accent-tinted fill + checkmark), reflowed into a fixed-
/// width card sized off `SubParamChip`'s (`SubParamRow.swift`) established
/// phone-bar rhythm — 10pt horizontal / rounded capsule-ish padding, 10-11pt
/// label type — rather than a new set of numbers.
private struct FilmLookCard: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text(title)
                    .font(.system(size: 11, weight: isSelected ? .semibold : .medium))
                    .foregroundStyle(isSelected ? ProTokens.accent : ProTokens.text)
                    .lineLimit(1)
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(ProTokens.accent)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(minWidth: 64)
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .background(
                isSelected ? ProTokens.accent(0x28) : ProTokens.panel,
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(isSelected ? ProTokens.accent : ProTokens.border, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title) film look")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

// MARK: - Preview

#if DEBUG
#Preview("FilmLookStrip") {
    let looks = Array(FilmCatalog.all.prefix(6))
    return FilmLookStrip(
        looks: looks,
        activeLookId: looks.first?.id ?? "",
        onSelectLook: { _ in },
        onSelectNone: {}
    )
    .padding()
    .background(ProTokens.bg)
}
#endif
