// SearchActiveFilterChips.swift
//
// Active-filter chip row for the unified search UI (#2866) — one chip per
// active filter (date range, each person, each place), each with a remove
// ×. Shown with the search field on every platform that hosts the panel
// (CloudSearchView on macOS/iPad, SearchView on iPhone). Chips beyond
// `maxVisible` collapse into a "+N" affordance that opens the filter UI.
//
// Chip derivation lives in SearchActiveFilterChips+VM.swift (the
// `+VM.swift` pattern, issue #192) — this file only renders.

import SwiftUI
import MapleCore

struct SearchActiveFilterChips: View {
  @Bindable var vm: SearchViewModel
  /// Open the filter panel/sheet — wired to the "+N" overflow chip.
  var onOpenFilters: () -> Void = {}

  /// Chips shown before collapsing the rest into "+N".
  private static let maxVisible = 4

  private typealias Chip = SearchActiveFilterChipsVM.Chip

  var body: some View {
    let all = SearchActiveFilterChipsVM.chips(params: vm.params, applied: vm.appliedDates)
    if all.isEmpty {
      EmptyView()
    } else {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(all.prefix(Self.maxVisible)) { chip in
            chipView(chip)
          }
          if all.count > Self.maxVisible {
            overflowChip(all.count - Self.maxVisible)
          }
        }
        .padding(.vertical, 2)
      }
      .accessibilityIdentifier("search-active-filter-chips")
    }
  }

  private func chipView(_ chip: Chip) -> some View {
    HStack(spacing: 5) {
      Image(systemName: chip.icon)
        .font(.system(size: 10))
        .foregroundStyle(MapleTokens.textMuted)
      Text(chip.label)
        .font(MapleTokens.Typography.chipLabel)
        .foregroundStyle(MapleTokens.textMain)
        .lineLimit(1)
      // No clear button on a window the user did not set: suppressing the
      // parse needs an API parameter that does not exist yet, so an X that
      // silently did nothing would be worse than none (#2956).
      if SearchActiveFilterChipsVM.explanation(for: chip) == nil {
        Button {
          remove(chip)
        } label: {
          Image(systemName: "xmark")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(MapleTokens.textMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Remove filter \(chip.label)")
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(MapleTokens.surfaceAlt, in: Capsule())
    .overlay(
      Capsule().strokeBorder(
        MapleTokens.border,
        style: StrokeStyle(
          lineWidth: 0.5,
          // Dashed marks it as provisional and explainable without competing
          // with the user's own chips or inventing a colour the token set
          // does not have.
          dash: SearchActiveFilterChipsVM.explanation(for: chip) == nil ? [] : [3, 2]
        )
      )
    )
    .help(SearchActiveFilterChipsVM.explanation(for: chip) ?? "")
    .accessibilityHint(SearchActiveFilterChipsVM.explanation(for: chip) ?? "")
  }

  private func overflowChip(_ count: Int) -> some View {
    Button(action: onOpenFilters) {
      Text("+\(count)")
        .font(MapleTokens.Typography.chipLabel)
        .foregroundStyle(MapleTokens.textMain)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(MapleTokens.surfaceAlt, in: Capsule())
        .overlay(Capsule().stroke(MapleTokens.border, lineWidth: 0.5))
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(count) more filters")
    .accessibilityIdentifier("search-filter-overflow")
  }

  private func remove(_ chip: Chip) {
    switch chip {
    case .date:
      vm.params.from = nil
      vm.params.to = nil
    case .person(let name):
      vm.params.people = vm.params.people.filter { $0 != name }
    case .place(let label):
      vm.params.place = vm.params.place.filter { $0 != label }
    case .inferredDate:
      // Not user-set, so there is nothing in `params` to clear. The chip
      // renders without an X; this arm keeps the switch exhaustive.
      return
    }
    Task { await vm.submit() }
  }
}
