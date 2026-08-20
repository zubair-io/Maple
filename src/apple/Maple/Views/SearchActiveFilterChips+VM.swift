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
    /// A window the SERVER read out of the query text. Carries the text it
    /// came from so the chip can say why it is there — the user did not set
    /// it, and nothing in the filter panel reflects it (#2956).
    case inferredDate(label: String, from: String)

    var id: String {
      switch self {
      case .date: return "date"
      case .person(let name): return "person:\(name)"
      case .place(let label): return "place:\(label)"
      case .inferredDate: return "inferred-date"
      }
    }

    var label: String {
      switch self {
      case .date(let label): return label
      case .person(let name): return name
      case .place(let label): return label
      case .inferredDate(let label, _): return label
      }
    }

    var icon: String {
      switch self {
      case .date: return "calendar"
      case .person: return "person"
      case .place: return "mappin.and.ellipse"
      // Still a date, and reads as one. What sets it apart is the
      // explanatory text and the chip's dashed treatment, not a new glyph.
      case .inferredDate: return "calendar"
      }
    }
  }

  /// One chip per active unified filter, date first, then people, then
  /// places — matching the panel's section order.
  static func chips(
    params: SearchParams,
    applied: AppliedDateFilter? = nil,
    now: Date = Date()
  ) -> [Chip] {
    let dateChip: [Chip] = dateLabel(from: params.from, to: params.to, now: now)
      .map { [.date(label: $0)] } ?? []
    // Appended, not prepended: the user's own filters keep their established
    // order and the derived one reads as an addition to them.
    return dateChip
      + params.people.map { Chip.person($0) }
      + params.place.map { Chip.place($0) }
      + inferredChip(applied, now: now)
  }

  /// The chip for a server-inferred window, or none. Absent when the window
  /// was explicit — the ordinary date chip already represents that.
  static func inferredChip(_ applied: AppliedDateFilter?, now: Date = Date()) -> [Chip] {
    guard let applied, let inferredFrom = applied.inferredFrom else { return [] }
    // The wire form is a full ISO instant; `SearchDateFormat` parses
    // `yyyy-MM-dd` and echoes anything else back raw, so trim to the day
    // before formatting or the chip renders "2024-01-01T00:00:00.000Z".
    let label = dateLabel(from: isoDay(applied.from), to: isoDay(applied.to), now: now)
    guard let label else { return [] }
    return [.inferredDate(label: label, from: inferredFrom)]
  }

  private static func isoDay(_ instant: String?) -> String? {
    instant.map { String($0.prefix(10)) }
  }

  /// Why a chip the user never set is on screen. Only the derived one needs
  /// explaining; the rest are the user's own choices.
  static func explanation(for chip: Chip) -> String? {
    guard case .inferredDate(_, let from) = chip else { return nil }
    return "Date filter from your search text \u{201C}\(from)\u{201D}"
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
