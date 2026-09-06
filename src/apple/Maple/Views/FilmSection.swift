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
//   │ [Black & White] [Cinema Print] [Color Neg] ›    │  ← category chips
//   ├────────────────────────────────────────────────┤
//   │  None                                       ✓   │  ← clears the look,
//   │  Agfa APX 100                                   │     pinned above the
//   │  Agfa APX 25                                    │     SELECTED
//   │  …                                              │     category's looks
//   ├────────────────────────────────────────────────┤
//   │  Strength      ──────────●───────────    100    │  ← only while a
//   └────────────────────────────────────────────────┘     look is active
//
// One category's looks (~10-20 rows) at a time, not all six stacked into a
// single ~600-row scroll (round-2 live feedback: the flat scroll was too
// long to navigate). The chip row lets the user switch categories; the list
// below shows only the selected one. `FilmCatalog.all` (generated from
// `raw-core`'s `FILM_CATALOG`) is grouped by `FilmCategory`; the chip row
// walks `FilmCategory.allCases` declaration order so the six chips always
// present in the same order. Picking a look is a discrete action — like the
// Black & White toggle in `EditorState.setBlackWhite` — so it commits its
// own undo boundary before the write, not a continuous drag. Strength IS a
// continuous scalar, so it is declared as `Tool.filmLook`'s one sub-param
// and rides the ordinary sub-param value pipe (`arm(subParamId:)` +
// `setArmedDisplayValue`), the same shape `ToneCurveSection`'s region
// sliders use.
//
// The category chip row is horizontally scrollable (six chips don't all fit
// the 300pt panel width) — it rides inside `FlyoutSliderPanel`, which
// reports its own frame as a wheel-exclusion region to `CanvasZoomHost`
// (#2683 round 2, Bug A fix): that exclusion covers the WHOLE panel, not
// just the look list, so trackpad scroll over the chip row reaches its
// `ScrollView` the same way it reaches the look list below, instead of
// hijacking the armed tool's wheel-nudge or the canvas zoom.
//
// The Angular twin owns its own `film-section.component.ts` (epic #2683
// Task 12); both read the same generated `FilmCatalog` / `filmLook` field
// so the two pickers can't drift on which looks exist.
//
// iPhone (#2794): the layout above is the macOS/iPad shape. `FilmSection`
// IS mounted in the phone chrome too (`MobileControlBar`,
// `IPhoneLegacyControlBar`), but a fixed 240pt vertical list plus the chip
// row and slider doesn't fit a phone's bottom control bar. On COMPACT width
// (`horizontalSizeClass == .compact`, i.e. iPhone) the look list is replaced
// by `FilmLookStrip` — a horizontally-scrolling row of look cards, same chip
// row on top and same strength slider below. Sizing is compact-first: read
// via `@Environment(\.horizontalSizeClass)`, same signal `ControlCard` /
// `LivingSliderGrid` / `EditorView` already branch on for the phone-vs-tablet
// split, so this doesn't invent a second convention for the same decision.
// The strip lives in a sibling file (`FilmLookStrip.swift`) rather than
// inline — this file was already near the 400-line soft budget.

import MapleCore
import SwiftUI

// MARK: - FilmSection

struct FilmSection: View {
  @Bindable var state: EditorState

  /// Compact width (iPhone) swaps the vertical look list for
  /// `FilmLookStrip`'s horizontal card row — see the file header note.
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  /// `FilmCatalog.all` grouped by category. Built once — the catalog is a
  /// static generated table, not session state.
  private static let looksByCategory: [FilmCategory: [FilmLookEntry]] =
    Dictionary(grouping: FilmCatalog.all, by: \.category)

  /// Film's one sub-param — declared on `Tool.filmLook` so its slider
  /// shares the ordinary arm/write/undo pipe every other tool's does.
  private static let strengthSub = Tool.filmLook.subParams[0]

  /// The category chip row's current selection. Local UI state, not part
  /// of the edit model — `.onAppear` (re-)derives it from the ACTIVE
  /// look's category each time the panel mounts (arming Film re-mounts
  /// `FilmSection`, per `FlyoutSliderPanel`'s tool-swap branches), so
  /// switching tools away and back to Film always lands the chip row on
  /// whichever category the current look actually belongs to, rather than
  /// remembering a stale in-session pick.
  @State private var selectedCategory: FilmCategory = FilmCategory.allCases.first ?? .blackWhite

  private var activeLookId: String { state.session.model.filmLook }
  private var isLookActive: Bool { !activeLookId.isEmpty }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      categoryChipRow
      if horizontalSizeClass == .compact {
        FilmLookStrip(
          looks: Self.looksByCategory[selectedCategory] ?? [],
          activeLookId: activeLookId,
          onSelectLook: selectLook,
          onSelectNone: clearLook
        )
      } else {
        lookList
      }
      if isLookActive {
        strengthSlider
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-film-section")
    .onAppear {
      selectedCategory = Self.defaultCategory(forActiveLookId: activeLookId)
    }
  }

  // MARK: - Category chip row

  private var categoryChipRow: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(FilmCategory.allCases, id: \.self) { category in
          FilmCategoryChip(
            category: category,
            isSelected: category == selectedCategory,
            action: { selectedCategory = category }
          )
        }
      }
      // Keeps the first/last chip's selection ring from clipping
      // against the scroll edge.
      .padding(.horizontal, 1)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("film-category-row")
  }

  /// The ACTIVE look's category, or the first category when no look is
  /// set (or the id doesn't resolve — a stale/removed catalog entry).
  private static func defaultCategory(forActiveLookId lookId: String) -> FilmCategory {
    FilmCatalog.all.first(where: { $0.id == lookId })?.category
      ?? FilmCategory.allCases.first
      ?? .blackWhite
  }

  static func categoryDisplayName(_ category: FilmCategory) -> String {
    switch category {
    case .blackWhite: return "Black & White"
    case .cinemaPrint: return "Cinema Print"
    case .colorNegative: return "Color Negative"
    case .consumerVintage: return "Consumer & Vintage"
    case .instant: return "Instant"
    case .slide: return "Slide"
    }
  }

  // MARK: - Look list

  /// Only the SELECTED category's looks — the None row stays pinned above
  /// them regardless of which category is showing, so clearing the look
  /// never requires switching categories first.
  private var lookList: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 2) {
        noneRow
        ForEach(Self.looksByCategory[selectedCategory] ?? [], id: \.id) { look in
          FilmLookRow(
            title: look.name,
            isSelected: look.id == activeLookId,
            action: { selectLook(look.id) }
          )
          .accessibilityIdentifier("film-look-row-\(look.id)")
        }
      }
    }
    // A FIXED height (not `maxHeight:`) rather than a ceiling: every
    // host that mounts `FilmSection` (`ControlCard`, `FlyoutSliderPanel`,
    // `StackedAdjustmentsPanel`, `MobileControlBar`,
    // `IPhoneLegacyControlBar`) hugs its content with no height of its
    // own, and `StackedAdjustmentsPanel` additionally nests this list
    // inside its own outer `ScrollView(.vertical)` — a `maxHeight:`
    // ceiling only caps an already-resolved ideal size, so an ambiguous
    // proposal from either kind of host can still resolve smaller than
    // one category's row count needs, clipping the tail with nothing
    // left to scroll. A fixed height removes the ambiguity outright:
    // this region is always exactly this tall, so its own scroll is
    // never in question. `.clipped()` backstops the boundary so a stray
    // row can't bleed past it while a host is still settling layout.
    .frame(height: 240)
    .clipped()
  }

  private var noneRow: some View {
    FilmLookRow(title: "None", isSelected: !isLookActive, action: clearLook)
      .accessibilityIdentifier("film-look-none")
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
      onEditingChanged: { editing in
        if editing { state.commit() } else { state.endGesture() }
      }
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
        in: RoundedRectangle(cornerRadius: MapleTokens.Radius.sm, style: .continuous)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(title) film look")
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }
}

// MARK: - FilmCategoryChip

/// One chip in the category row — same idiom `SubParamRow`'s
/// `SubParamChip` and `ControlCard`'s `GroupChipsRow` chip use (capsule,
/// accent fill + border when selected, plain label otherwise), rendered
/// with `ProTokens` to match the rest of this Pro-flyout panel rather than
/// `SubParamRow`'s `MapleTokens` (that one lives in the legacy DragBar
/// chrome).
private struct FilmCategoryChip: View {
  let category: FilmCategory
  let isSelected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(FilmSection.categoryDisplayName(category))
        .font(.system(size: 11, weight: isSelected ? .semibold : .medium))
        .foregroundStyle(isSelected ? ProTokens.accent : ProTokens.textMuted)
        .lineLimit(1)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
          Capsule().fill(isSelected ? ProTokens.accent(0x28) : Color.clear)
        )
        .overlay(
          Capsule().stroke(isSelected ? ProTokens.accent : ProTokens.border, lineWidth: 0.5)
        )
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(FilmSection.categoryDisplayName(category))
    .accessibilityAddTraits(isSelected ? .isSelected : [])
    .accessibilityIdentifier("film-category-\(category.rawValue)")
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
