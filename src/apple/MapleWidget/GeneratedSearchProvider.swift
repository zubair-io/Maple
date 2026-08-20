// GeneratedSearchProvider.swift
//
// Feeds the Maple widget from `/api/generated-searches` — the daily themed
// collections the server's generated-search worker invents.
//
// Two deliberate constraints shape this file:
//
//   * The widget NEVER composes its own search. It asks the server for a
//     collection's assets by id, because the server is where
//     `excludeHiddenPeople` and the screenshot exclusion are applied. A
//     widget that rebuilt the query from a card would quietly show a person
//     the operator hid — on a home screen, unattended. `GeneratedSearchCard`
//     does not even model the `query` field, so this is enforced by shape
//     rather than by discipline.
//
//   * Everything is best-effort. A widget that throws renders as a blank
//     tile; every failure path here lands on a `.empty` entry with a
//     near-future retry instead.

import Foundation
import MapleCloudKit
import WidgetKit

/// One rendered moment: a photo from a collection, plus the collection's own
/// title so the tile can say what you are looking at.
struct GeneratedSearchEntry: TimelineEntry {
  let date: Date
  let title: String
  let subtitle: String?
  /// JPEG/AVIF bytes for the photo, already fetched. `nil` renders the
  /// placeholder treatment rather than a broken tile.
  let imageData: Data?
  /// Deep-link target — the collection this photo came from.
  let collectionID: String?

  static func empty(at date: Date = Date()) -> GeneratedSearchEntry {
    GeneratedSearchEntry(
      date: date,
      title: "Maple",
      subtitle: nil,
      imageData: nil,
      collectionID: nil
    )
  }
}

struct GeneratedSearchProvider: TimelineProvider {
  /// How many photos one timeline cycles through before WidgetKit asks again.
  /// Six entries at ~40 minutes covers a normal waking stretch without
  /// burning the system's refresh budget on a once-a-day data source.
  private static let entriesPerTimeline = 6
  private static let entryInterval: TimeInterval = 40 * 60

  /// How long to wait before rebuilding the timeline. The underlying
  /// collections change once a day, so there is nothing to gain from asking
  /// more often than a few hours.
  private static let refreshInterval: TimeInterval = 4 * 60 * 60

  func placeholder(in context: Context) -> GeneratedSearchEntry {
    .empty()
  }

  func getSnapshot(in context: Context, completion: @escaping (GeneratedSearchEntry) -> Void) {
    // The gallery preview must not block on the network.
    if context.isPreview {
      completion(.empty())
      return
    }
    Task {
      let entries = await Self.buildEntries()
      completion(entries.first ?? .empty())
    }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<GeneratedSearchEntry>) -> Void) {
    Task {
      let entries = await Self.buildEntries()
      let refreshAt = Date().addingTimeInterval(Self.refreshInterval)
      guard !entries.isEmpty else {
        // Nothing to show — not signed in, no collections yet, or the server
        // is unreachable. Retry sooner than a full cycle, but not so soon
        // that a persistently-signed-out widget spins.
        completion(Timeline(entries: [.empty()], policy: .after(Date().addingTimeInterval(30 * 60))))
        return
      }
      completion(Timeline(entries: entries, policy: .after(refreshAt)))
    }
  }

  // MARK: - Data

  /// Resolve the signed-in server and selected library from the App Group,
  /// then build one timeline's worth of entries. Returns `[]` on any failure
  /// — the caller decides what to render.
  private static func buildEntries() async -> [GeneratedSearchEntry] {
    guard let context = WidgetSession.current() else { return [] }

    do {
      let collections = try await context.generatedSearch.collections(
        libraryID: context.libraryID
      )
      guard let collection = collections.randomElement() else { return [] }

      let assets = try await context.generatedSearch.assets(
        collectionID: collection.id,
        limit: entriesPerTimeline
      )
      guard !assets.isEmpty else { return [] }

      var entries: [GeneratedSearchEntry] = []
      let start = Date()
      for (index, asset) in assets.prefix(entriesPerTimeline).enumerated() {
        // A thumb failure loses one photo, not the whole tile.
        let data = try? await context.thumbs.thumb(absPath: asset.abs_path)
        entries.append(
          GeneratedSearchEntry(
            date: start.addingTimeInterval(Double(index) * entryInterval),
            title: collection.title,
            subtitle: collection.subtitle,
            imageData: data,
            collectionID: collection.id
          )
        )
      }
      return entries
    } catch {
      return []
    }
  }
}
