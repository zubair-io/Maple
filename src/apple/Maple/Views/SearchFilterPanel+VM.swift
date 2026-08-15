// SearchFilterPanel+VM.swift — pure-function view-model helpers for
// SearchFilterPanel.
//
// Co-located sibling of SearchFilterPanel.swift, per the `+VM.swift`
// pattern (issue #192): non-trivial derivation lives here, takes typed
// inputs, returns typed outputs — no SwiftUI, no @State, no view-builder
// closures — so it's unit-testable in isolation (SearchFilterVMTests in
// the MapleTests target). MUST NOT `import SwiftUI`. MapleCore IS
// imported (SearchParams / ValueFacet are data types, not a view
// framework).

import Foundation
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

  /// The preset whose computed range matches `from`/`to` exactly, if any —
  /// a custom-picked range matches none. Shared by the panel's preset
  /// chips and the active-chips row's date label, so the two surfaces
  /// can't disagree about what counts as "the preset".
  static func matching(from: String?, to: String?,
                       now: Date = Date(),
                       calendar: Calendar = .current) -> SearchDatePreset? {
    guard let from, let to else { return nil }
    return allCases.first { preset in
      let range = preset.range(now: now, calendar: calendar)
      return range.from == from && range.to == to
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

enum SearchFilterPanelVM {
  struct FacetRow: Identifiable, Equatable {
    let value: String
    let count: Int?
    var id: String { value }
  }

  /// Facet rows, unioned with any selected values the (filter-aware)
  /// facet list no longer carries — a selected filter must always stay
  /// visible and removable. Facet entries with a nil/empty value (the
  /// server's "field absent" bucket) are dropped.
  static func rowModels(facets: [ValueFacet], selected: [String]) -> [FacetRow] {
    let fromFacets = facets.compactMap { facet -> FacetRow? in
      guard let value = facet.value, !value.isEmpty else { return nil }
      return FacetRow(value: value, count: facet.count)
    }
    let known = Set(fromFacets.map(\.value))
    let orphans = selected.filter { !known.contains($0) }
      .map { FacetRow(value: $0, count: nil) }
    return orphans + fromFacets
  }

  /// Multi-select toggle: remove `value` when present, append when not.
  static func toggled(_ array: [String], _ value: String) -> [String] {
    array.contains(value) ? array.filter { $0 != value } : array + [value]
  }
}
