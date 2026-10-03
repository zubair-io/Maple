// TopShelfBuilder.swift
//
// Turns fetched content into Top Shelf entries. Split from `TopShelfCache`
// (storage) and from the extension's provider (platform glue) for the same
// reason `LightTablePool` is split from `LightTableViewModel`: the selection
// policy is pure data-in/data-out and belongs where `swift test` can exercise
// the real function rather than a hand-maintained mirror. There is no Xcode
// test bundle for Maple TV or its extensions.

import Foundation

public enum TopShelfBuilder {
  /// Entries for the day's memories.
  ///
  /// A collection whose cover couldn't be resolved is DROPPED, not shown on a
  /// placeholder. The Top Shelf is a Home-screen surface the viewer never
  /// opted into looking at; a grey tile there reads as the app being broken,
  /// where one fewer memory reads as nothing at all.
  public static func entries(
    forMemories collections: [GeneratedSearchCard],
    covers: [String: SearchAsset],
    limit: Int = TopShelfCache.maxEntries
  ) -> [TopShelfEntry] {
    collections
      .filter { covers[$0.id] != nil }
      .prefix(limit)
      .map { collection in
        TopShelfEntry(
          id: collection.id,
          title: collection.title,
          subtitle: photoCount(collection.result_count),
          imageFileName: TopShelfCache.imageFileName(forEntryID: collection.id)
        )
      }
  }

  /// Entries for the recents fallback, used when the day produced no
  /// memories — a paused generated-search worker, a fresh pairing, or a day
  /// whose proposals all missed the result floor. Without this the shelf
  /// would be empty in exactly the situations where the app looks least
  /// finished.
  public static func entries(
    forRecents assets: [SearchAsset],
    limit: Int = TopShelfCache.maxEntries
  ) -> [TopShelfEntry] {
    assets.prefix(limit).map { asset in
      TopShelfEntry(
        id: asset.id,
        title: asset.filename,
        subtitle: captureDate(asset.captured_at),
        imageFileName: TopShelfCache.imageFileName(forEntryID: asset.id)
      )
    }
  }

  private static func photoCount(_ count: Int) -> String {
    count == 1 ? "1 photo" : "\(count) photos"
  }

  /// The `parseTimelineISO8601` helper lives in the Maple TV target, so this
  /// keeps its own tolerant parse: the server sends millisecond-precision
  /// `captured_at`, and a bare `ISO8601DateFormatter` drops those — the bug
  /// that once left the whole tvOS timeline empty.
  private static func captureDate(_ isoString: String?) -> String? {
    guard let isoString else { return nil }
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    guard let date = withFraction.date(from: isoString) ?? plain.date(from: isoString) else {
      return nil
    }
    return date.formatted(date: .abbreviated, time: .omitted)
  }
}
