// FilmSection.swift — Film tool surface (#2683).
//
// Replaces the group's living-slider stack while the Film tool is armed,
// the same swap-in-a-custom-surface pattern `ToneCurveSection` (#367) and
// `HSLSection` (#274) use — and for the same structural reason: the
// catalog pick (`AdjustmentModel.filmLook`) is a string id chosen from a
// list, not a scalar, so `ToolValueMapping.displayRange` is nil for
// `.filmLook` and this section IS its control surface.
//
//   ┌────────────────────────────────────────────────┐
//   │  None                                       ✓   │  ← clears the look
//   │  BLACK & WHITE                                  │  ← category header
//   │  Agfa APX 100                                   │
//   │  Agfa APX 25                                    │
//   │  …                                              │
//   │  COLOR NEGATIVE                                 │
//   │  Kodak Portra 400                          ✓    │  ← selected look
//   │  …                                              │
//   ├────────────────────────────────────────────────┤
//   │  Strength      ──────────●───────────    100    │  ← only while a
//   └────────────────────────────────────────────────┘     look is active
//
// `FilmCatalog.all` (generated from `raw-core`'s `FILM_CATALOG`) is grouped
// by `FilmCategory`, walked in `FilmCategory.allCases` declaration order so
// the section list always presents the same six groups in the same order.
// Picking a look is a discrete action — like the Black & White toggle in
// `EditorState.setBlackWhite` — so it commits its own undo boundary before
// the write, not a continuous drag. Strength IS a continuous scalar, so it
// is declared as `Tool.filmLook`'s one sub-param and rides the ordinary
// sub-param value pipe (`arm(subParamId:)` + `setArmedDisplayValue`), the
// same shape `ToneCurveSection`'s region sliders use.
//
// The Angular twin owns its own `film-section.component.ts` (epic #2683
// Task 12); both read the same generated `FilmCatalog` / `filmLook` field
// so the two pickers can't drift on which looks exist.

import MapleCore
import SwiftUI

// MARK: - FilmSection

struct FilmSection: View {
    @Bindable var state: EditorState

    /// `FilmCatalog.all` grouped by category, in `FilmCategory.allCases`
    /// order. Built once — the catalog is a static generated table, not
    /// session state.
    private static let categorized: [(category: FilmCategory, looks: [FilmLookEntry])] = {
        let grouped = Dictionary(grouping: FilmCatalog.all, by: \.category)
        return FilmCategory.allCases.compactMap { category in
            grouped[category].map { (category, $0) }
        }
    }()

    /// Film's one sub-param — declared on `Tool.filmLook` so its slider
    /// shares the ordinary arm/write/undo pipe every other tool's does.
    private static let strengthSub = Tool.filmLook.subParams[0]

    private var activeLookId: String { state.session.model.filmLook }
    private var isLookActive: Bool { !activeLookId.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            lookList
            if isLookActive {
                strengthSlider
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor-film-section")
    }

    // MARK: - Look list

    private var lookList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                noneRow
                ForEach(Self.categorized, id: \.category) { entry in
                    categorySection(entry.category, entry.looks)
                }
            }
        }
        .frame(maxHeight: 280)
    }

    private var noneRow: some View {
        FilmLookRow(title: "None", isSelected: !isLookActive, action: clearLook)
            .accessibilityIdentifier("film-look-none")
    }

    private func categorySection(_ category: FilmCategory, _ looks: [FilmLookEntry]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(Self.categoryDisplayName(category).uppercased())
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(ProTokens.textMuted)
                .padding(.top, 8)
                .accessibilityIdentifier("film-category-\(category.rawValue)")
            ForEach(looks, id: \.id) { look in
                FilmLookRow(
                    title: look.name,
                    isSelected: look.id == activeLookId,
                    action: { selectLook(look.id) }
                )
                .accessibilityIdentifier("film-look-row-\(look.id)")
            }
        }
    }

    private static func categoryDisplayName(_ category: FilmCategory) -> String {
        switch category {
        case .blackWhite:       return "Black & White"
        case .cinemaPrint:      return "Cinema Print"
        case .colorNegative:    return "Color Negative"
        case .consumerVintage:  return "Consumer & Vintage"
        case .instant:          return "Instant"
        case .slide:            return "Slide"
        }
    }

    // MARK: - Strength slider

    private var strengthSlider: some View {
        LivingSlider(
            label: Self.strengthSub.label,
            value: Binding(
                get: { state.session.model[keyPath: Self.strengthSub.keyPath] },
                set: { newValue in
                    if state.armedSubParamId != Self.strengthSub.id {
                        state.arm(subParamId: Self.strengthSub.id)
                    }
                    state.setArmedDisplayValue(newValue)
                }
            ),
            range: Self.strengthSub.range,
            isBipolar: false,
            defaultValue: Self.strengthSub.defaultDisplayValue,
            onCommit: { state.commit() }
        )
        .accessibilityIdentifier("slider-film-strength")
    }

    // MARK: - Writes

    /// Selecting a look is a discrete pick, not a continuous drag, so it
    /// commits its own undo boundary before the write — the same shape
    /// `EditorState.setBlackWhite` uses for its on/off toggle.
    private func selectLook(_ id: String) {
        let alreadySelected = id == activeLookId
        guard !alreadySelected else { return }
        state.commit()
        state.session.model.filmLook = id
    }

    private func clearLook() {
        guard isLookActive else { return }
        state.commit()
        state.session.model.filmLook = ""
    }
}

// MARK: - FilmLookRow

/// One row in the look list — the film-look twin of `PresetsPanel`'s
/// `presetRow`: a plain-text button with a trailing checkmark when
/// selected.
private struct FilmLookRow: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? ProTokens.accent : ProTokens.text)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(ProTokens.accent)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
            .background(
                isSelected ? ProTokens.accent(0x1A) : Color.clear,
                in: RoundedRectangle(cornerRadius: 6, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title) film look")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

// MARK: - Preview

#if DEBUG
#Preview("FilmSection") {
    let state = EditorState(session: EditSession.preview())
    return FilmSection(state: state)
        .frame(width: 320)
        .padding()
        .background(ProTokens.bg)
}
#endif
