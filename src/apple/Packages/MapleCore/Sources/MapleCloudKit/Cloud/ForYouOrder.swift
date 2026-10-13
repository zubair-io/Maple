// ForYouOrder.swift
//
// The For You cards' "randomish" order (#4594). The server's order is the
// worker's, so the same cards would lead every visit; the clients shuffle
// instead. The shuffle happens when a library's set first loads in a session
// (an app launch, a library switch, a new day's set) and is then held: a
// reload, a tab return or a late cover must never move a card under the
// user's finger. The server's order and the API are untouched.

import Foundation

enum ForYouOrder {
  /// `ids` in an order that keeps every card already in `previous` where it
  /// was relative to the others, and drops each new card at a random
  /// position. With an empty `previous` that is a uniform shuffle.
  static func arrange<R: RandomNumberGenerator>(
    _ ids: [String], keeping previous: [String], using random: inout R
  ) -> [String] {
    let incoming = Set(ids)
    let survivors = previous.filter(incoming.contains)
    let kept = Set(survivors)
    return ids.filter { !kept.contains($0) }.reduce(into: survivors) { order, id in
      order.insert(id, at: Int.random(in: 0...order.count, using: &random))
    }
  }

  /// The day a set was generated for. A set is one day's run, so any card's
  /// date names it; the latest wins should a response ever straddle two.
  static func day(of cards: [GeneratedSearchCard]) -> String {
    cards.map(\.generated_for).max() ?? ""
  }
}

/// The order each library's cards were shown in during this process, so a
/// reload — or a fresh view model for the same library, which tvOS builds on
/// every visit to Memories — keeps it. Process-lifetime on purpose: the next
/// launch reshuffles.
@MainActor
public final class ForYouSessionOrder {
  public static let shared = ForYouSessionOrder()

  private struct Shown {
    let day: String
    let ids: [String]
  }

  private var shown: [String: Shown] = [:]

  public nonisolated init() {}

  /// What `libraryID` showed for `day`; empty when it showed nothing yet or a
  /// different day's set, which is what makes a new day reshuffle.
  func order(for libraryID: String, day: String) -> [String] {
    guard let entry = shown[libraryID], entry.day == day else { return [] }
    return entry.ids
  }

  func record(_ ids: [String], day: String, for libraryID: String) {
    shown[libraryID] = Shown(day: day, ids: ids)
  }
}

/// Type-erased so a view model can hold the injected generator (a seeded one
/// in tests) without becoming generic over it.
struct AnyRandomNumberGenerator: RandomNumberGenerator {
  private var base: any RandomNumberGenerator

  init(_ base: some RandomNumberGenerator) {
    self.base = base
  }

  mutating func next() -> UInt64 {
    base.next()
  }
}
