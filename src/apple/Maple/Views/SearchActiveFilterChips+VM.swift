// SearchActiveFilterChips+VM.swift — pure-function view-model helpers for
// SearchActiveFilterChips.
//
// Co-located sibling of SearchActiveFilterChips.swift, per the `+VM.swift`
// pattern (issue #192): chip derivation from `SearchParams` lives here —
// no SwiftUI import — so it's unit-testable in isolation
// (SearchFilterVMTests in the MapleTests target).

import Foundation
import MapleCore

enum SearchActiveFilterChipsVM {
  enum Chip: Identifiable, Equatable {
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

  /// One chip per active unified filter, date first, then people, then
  /// places — matching the panel's section order.
  static func chips(params: SearchParams, now: Date = Date()) -> [Chip] {
    let dateChip: [Chip] = dateLabel(from: params.from, to: params.to, now: now)
      .map { [.date(label: $0)] } ?? []
    return dateChip
      + params.people.map { Chip.person($0) }
      + params.place.map { Chip.place($0) }
  }

  /// Preset label when the range matches a preset exactly, else the
  /// formatted custom range ("Jan 3 – Feb 1, 2026" / "From Jan 3, 2026").
  static func dateLabel(from: String?, to: String?, now: Date = Date()) -> String? {
    guard from != nil || to != nil else { return nil }
    if let from, let to {
      if let preset = SearchDatePreset.matching(from: from, to: to, now: now) {
        return preset.label
      }
      return "\(SearchDateFormat.display(from)) – \(SearchDateFormat.display(to))"
    }
    if let from { return "From \(SearchDateFormat.display(from))" }
    return to.map { "Until \(SearchDateFormat.display($0))" }
  }
}
