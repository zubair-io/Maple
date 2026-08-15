// SearchFilterPanel.swift
//
// The unified search filter surface (#2866, epic #2862): Date range,
// People, and Places — the same three-filter model as the web search
// page. Replaces the old EXIF filter popover (camera/lens/ISO/aperture/
// focal/scene/subjects/screenshot), which is no longer part of search.
//
// Hosted two ways: macOS/iPad docks it as a right-hand panel beside the
// results (CloudSearchView); iPhone presents it as a sheet (SearchView).
// Every control re-runs the search immediately on change, so the footer's
// "Show N results" count (facets.total) is always live.

import SwiftUI
import MapleCore

/// Single-select date presets. `range` computes the from/to strings the
/// server expects (`YYYY-MM-DD`, widened server-side).
enum SearchDatePreset: String, CaseIterable, Identifiable {
  case today, last7, last30, thisYear

  var id: String { rawValue }

  var label: String {
    switch self {
    case .today: return "Today"
    case .last7: return "Last 7 days"
    case .last30: return "Last 30 days"
    case .thisYear: return "This year"
    }
  }

  func range(now: Date = Date(), calendar: Calendar = .current) -> (from: String, to: String) {
    let today = SearchDateFormat.string(from: now)
    switch self {
    case .today:
      return (today, today)
    case .last7:
      let start = calendar.date(byAdding: .day, value: -6, to: now) ?? now
      return (SearchDateFormat.string(from: start), today)
    case .last30:
      let start = calendar.date(byAdding: .day, value: -29, to: now) ?? now
      return (SearchDateFormat.string(from: start), today)
    case .thisYear:
      let year = calendar.component(.year, from: now)
      return (String(format: "%04d-01-01", year), today)
    }
  }
}

/// `YYYY-MM-DD` ↔ `Date` conversion for the date filter fields — the
/// exact wire shape `SearchParams.from` / `.to` carry.
enum SearchDateFormat {
  private static let formatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.locale = Locale(identifier: "en_US_POSIX")
    return f
  }()

  static func string(from date: Date) -> String { formatter.string(from: date) }
  static func date(from string: String) -> Date? { formatter.date(from: string) }

  /// Human-readable chip label for a stored `YYYY-MM-DD`, falling back to
  /// the raw string when unparseable.
  static func display(_ string: String) -> String {
    guard let date = date(from: string) else { return string }
    return date.formatted(date: .abbreviated, time: .omitted)
  }
}

struct SearchFilterPanel: View {
  @Bindable var vm: SearchViewModel
  /// Dismiss the hosting surface (sheet / docked panel) — wired to the
  /// footer's "Show N results".
  var onClose: () -> Void = {}

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider().overlay(MapleTokens.border)
      ScrollView {
        VStack(alignment: .leading, spacing: MapleTokens.Spacing.sectionGap) {
          dateSection
          facetRowsSection(title: "People",
                           rows: rowModels(facets: vm.peopleFacets, selected: vm.params.people),
                           icon: .personInitial,
                           selected: vm.params.people,
                           toggle: togglePerson)
          facetRowsSection(title: "Places",
                           rows: rowModels(facets: vm.placeFacets, selected: vm.params.place),
                           icon: .location,
                           selected: vm.params.place,
                           toggle: togglePlace)
        }
        .padding(MapleTokens.Spacing.panelInset)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      Divider().overlay(MapleTokens.border)
      footer
    }
    .background(MapleTokens.surface)
  }

  // MARK: - Header / footer

  private var header: some View {
    HStack {
      Text("Filters")
        .font(MapleTokens.Typography.sheetTitle)
        .foregroundStyle(MapleTokens.textMain)
      Spacer()
    }
    .padding(.horizontal, MapleTokens.Spacing.panelInset)
    .padding(.vertical, 10)
  }

  private var footer: some View {
    HStack {
      Button("Clear all") { vm.clearFilters() }
        .buttonStyle(.plain)
        .font(MapleTokens.Typography.body)
        .foregroundStyle(MapleTokens.textMuted)
        .disabled(!vm.hasUnifiedFilters)
        .accessibilityIdentifier("search-clear-filters")
      Spacer()
      Button(action: onClose) {
        Text(showResultsLabel)
          .font(MapleTokens.Typography.chipLabel)
          .foregroundStyle(.white)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .background(MapleTokens.primary, in: Capsule())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("search-show-results")
    }
    .padding(.horizontal, MapleTokens.Spacing.panelInset)
    .padding(.vertical, 10)
  }

  private var showResultsLabel: String {
    vm.facetTotal == 1 ? "Show 1 result" : "Show \(vm.facetTotal) results"
  }

  // MARK: - Date range

  private var dateSection: some View {
    section("Date range") {
      VStack(alignment: .leading, spacing: 10) {
        presetChips
        dateFieldRow(label: "From", keyPath: \.from)
        dateFieldRow(label: "To", keyPath: \.to)
      }
    }
  }

  private var presetChips: some View {
    let active = activePreset
    return LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: 6)],
                     alignment: .leading, spacing: 6) {
      ForEach(SearchDatePreset.allCases) { preset in
        chip(preset.label, selected: preset == active) {
          // Single-select toggle: tapping the active preset clears the range.
          let range = preset.range()
          let clearing = preset == active
          vm.params.from = clearing ? nil : range.from
          vm.params.to = clearing ? nil : range.to
          Task { await vm.submit() }
        }
        .accessibilityIdentifier("search-date-preset-\(preset.rawValue)")
      }
    }
  }

  /// The preset whose computed range matches the current from/to exactly,
  /// if any — a custom-picked range matches none and lights no chip.
  private var activePreset: SearchDatePreset? {
    guard let from = vm.params.from, let to = vm.params.to else { return nil }
    return SearchDatePreset.allCases.first { preset in
      let range = preset.range()
      return range.from == from && range.to == to
    }
  }

  /// A custom date bound: unset shows an "Add" affordance (sets today,
  /// revealing the picker); set shows a compact `DatePicker` + clear.
  @ViewBuilder
  private func dateFieldRow(label: String,
                            keyPath: WritableKeyPath<SearchParams, String?>) -> some View {
    HStack(spacing: 8) {
      Text(label)
        .font(MapleTokens.Typography.rowLabel)
        .foregroundStyle(MapleTokens.textMuted)
        .frame(width: 44, alignment: .leading)
      if vm.params[keyPath: keyPath] != nil {
        DatePicker("", selection: dateBinding(keyPath), displayedComponents: .date)
          .labelsHidden()
          .datePickerStyle(.compact)
        Button {
          vm.params[keyPath: keyPath] = nil
          Task { await vm.submit() }
        } label: {
          Image(systemName: "xmark.circle.fill")
            .foregroundStyle(MapleTokens.textMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear \(label.lowercased()) date")
      } else {
        Button {
          vm.params[keyPath: keyPath] = SearchDateFormat.string(from: Date())
          Task { await vm.submit() }
        } label: {
          Label("Add date", systemImage: "calendar.badge.plus")
            .font(MapleTokens.Typography.body)
            .foregroundStyle(MapleTokens.primary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Add \(label.lowercased()) date")
      }
      Spacer()
    }
  }

  private func dateBinding(_ keyPath: WritableKeyPath<SearchParams, String?>) -> Binding<Date> {
    Binding(
      get: {
        vm.params[keyPath: keyPath].flatMap(SearchDateFormat.date(from:)) ?? Date()
      },
      set: { newValue in
        vm.params[keyPath: keyPath] = SearchDateFormat.string(from: newValue)
        Task { await vm.submit() }
      })
  }

  // MARK: - People / Places rows

  private enum RowIcon {
    case personInitial
    case location
  }

  private struct FacetRow: Identifiable {
    let value: String
    let count: Int?
    var id: String { value }
  }

  /// Facet rows, unioned with any selected values the (filter-aware)
  /// facet list no longer carries — a selected filter must always stay
  /// visible and removable.
  private func rowModels(facets: [ValueFacet], selected: [String]) -> [FacetRow] {
    let fromFacets = facets.compactMap { facet -> FacetRow? in
      guard let value = facet.value, !value.isEmpty else { return nil }
      return FacetRow(value: value, count: facet.count)
    }
    let known = Set(fromFacets.map(\.value))
    let orphans = selected.filter { !known.contains($0) }
      .map { FacetRow(value: $0, count: nil) }
    return orphans + fromFacets
  }

  @ViewBuilder
  private func facetRowsSection(title: String,
                                rows: [FacetRow],
                                icon: RowIcon,
                                selected: [String],
                                toggle: @escaping (String) -> Void) -> some View {
    if rows.isEmpty {
      EmptyView()
    } else {
      section(title) {
        VStack(spacing: 2) {
          ForEach(rows) { row in
            facetRow(row, icon: icon, isSelected: selected.contains(row.value)) {
              toggle(row.value)
            }
          }
        }
      }
    }
  }

  private func facetRow(_ row: FacetRow,
                        icon: RowIcon,
                        isSelected: Bool,
                        action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 10) {
        rowIcon(icon, value: row.value)
        Text(row.value)
          .font(MapleTokens.Typography.rowLabel)
          .foregroundStyle(MapleTokens.textMain)
          .lineLimit(1)
        Spacer()
        if let count = row.count {
          Text("\(count)")
            .font(MapleTokens.Typography.body)
            .foregroundStyle(MapleTokens.textMuted)
        }
        if isSelected {
          Image(systemName: "checkmark")
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(MapleTokens.primary)
        }
      }
      .padding(.vertical, 5)
      .padding(.horizontal, 6)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .background(isSelected ? MapleTokens.surfaceAlt : .clear,
                in: RoundedRectangle(cornerRadius: 6))
    .accessibilityLabel(row.value)
    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
  }

  @ViewBuilder
  private func rowIcon(_ icon: RowIcon, value: String) -> some View {
    switch icon {
    case .personInitial:
      Circle()
        .fill(MapleTokens.surfaceAlt)
        .frame(width: 26, height: 26)
        .overlay {
          Text(value.prefix(1).uppercased())
            .font(MapleTokens.Typography.chipLabel)
            .foregroundStyle(MapleTokens.textMain)
        }
    case .location:
      Circle()
        .fill(MapleTokens.surfaceAlt)
        .frame(width: 26, height: 26)
        .overlay {
          Image(systemName: "mappin.and.ellipse")
            .font(.system(size: 12))
            .foregroundStyle(MapleTokens.textMuted)
        }
    }
  }

  private func togglePerson(_ value: String) {
    vm.params.people = toggled(vm.params.people, value)
    Task { await vm.submit() }
  }

  private func togglePlace(_ value: String) {
    vm.params.place = toggled(vm.params.place, value)
    Task { await vm.submit() }
  }

  private func toggled(_ array: [String], _ value: String) -> [String] {
    array.contains(value) ? array.filter { $0 != value } : array + [value]
  }

  // MARK: - Building blocks

  @ViewBuilder
  private func section<Content: View>(_ title: String,
                                      @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title.uppercased())
        .font(MapleTokens.Typography.eyebrow)
        .foregroundStyle(MapleTokens.textMuted)
      content()
    }
  }

  private func chip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(label)
        .font(MapleTokens.Typography.body)
        .foregroundStyle(selected ? .white : MapleTokens.textMain)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(selected ? MapleTokens.primary : MapleTokens.surfaceAlt,
                    in: Capsule())
    }
    .buttonStyle(.plain)
  }
}

// MARK: - Preview

#Preview("Filters") {
  SearchFilterPanel(vm: SearchViewModel.preview(.loaded))
    .frame(width: 320, height: 560)
}
