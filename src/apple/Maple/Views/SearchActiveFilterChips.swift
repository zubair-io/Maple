// SearchActiveFilterChips.swift
//
// Active-filter chip row for the unified search UI (#2866) — one chip per
// active filter (date range, each person, each place), each with a remove
// ×. Shown with the search field on every platform that hosts the panel
// (CloudSearchView on macOS/iPad, SearchView on iPhone). Chips beyond
// `maxVisible` collapse into a "+N" affordance that opens the filter UI.

import SwiftUI
import MapleCore

struct SearchActiveFilterChips: View {
  @Bindable var vm: SearchViewModel
  /// Open the filter panel/sheet — wired to the "+N" overflow chip.
  var onOpenFilters: () -> Void = {}

  /// Chips shown before collapsing the rest into "+N".
  private static let maxVisible = 4

  private enum Chip: Identifiable {
    case date(label: String)
    case person(String)
    case place(String)

    var id: String {
      switch self {
      case .date: return "date"
      case .person(let name): return "person:\(name)"
      case .place(let label): return "place:\(label)"
      }
    }

    var label: String {
      switch self {
      case .date(let label): return label
      case .person(let name): return name
      case .place(let label): return label
      }
    }

    var icon: String {
      switch self {
      case .date: return "calendar"
      case .person: return "person"
      case .place: return "mappin.and.ellipse"
      }
    }
  }

  private var chips: [Chip] {
    let dateChip: [Chip] = dateLabel.map { [.date(label: $0)] } ?? []
    return dateChip
      + vm.params.people.map { Chip.person($0) }
      + vm.params.place.map { Chip.place($0) }
  }

  /// Preset label when the range matches a preset exactly, else the
  /// formatted custom range ("Jan 3 – Feb 1, 2026" / "From Jan 3, 2026").
  private var dateLabel: String? {
    let from = vm.params.from
    let to = vm.params.to
    guard from != nil || to != nil else { return nil }
    if let from, let to {
      if let preset = SearchDatePreset.allCases.first(where: { p in
        let r = p.range()
        return r.from == from && r.to == to
      }) {
        return preset.label
      }
      return "\(SearchDateFormat.display(from)) – \(SearchDateFormat.display(to))"
    }
    if let from { return "From \(SearchDateFormat.display(from))" }
    return to.map { "Until \(SearchDateFormat.display($0))" }
  }

  var body: some View {
    let all = chips
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
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(MapleTokens.surfaceAlt, in: Capsule())
    .overlay(Capsule().stroke(MapleTokens.border, lineWidth: 0.5))
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
    }
    Task { await vm.submit() }
  }
}
