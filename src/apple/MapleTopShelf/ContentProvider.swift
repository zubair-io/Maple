// src/apple/MapleTopShelf/ContentProvider.swift
//
// Supplies Maple TV's Top Shelf: the content tvOS shows in place of the app
// icon when Maple TV sits in the Home screen's top row. A full-bleed carousel
// of the day's Memories, falling back to recent photos when the day produced
// none, and to the static icon when the Apple TV isn't paired.
//
// Two platform constraints drive the shape of this file.
//
// Images are `file://` URLs into the shared App Group container, never server
// URLs. `TVTopShelfItem`'s images are fetched by the SYSTEM, in its own
// process, with nowhere to attach a bearer token — and Maple's thumb/preview
// endpoints are bearer-gated with no query-token escape hatch. So the bytes
// have to be fetched by us and left on disk. `TopShelfCache` owns that.
//
// The provider must answer quickly or tvOS shows the static icon instead
// (`TVTopShelfContentProvider`'s own header says so). Cached content is
// therefore returned immediately whenever it is fresh, and a refresh only
// ever runs under a deadline — see `refreshDeadline`. Deferring the refresh
// until after returning is NOT an option: the extension can be terminated as
// soon as it answers, so "refresh in the background for next time" would
// simply never run.

import MapleCloudKit
import TVServices

final class ContentProvider: TVTopShelfContentProvider {
  /// How long a refresh may hold up the answer.
  ///
  /// This is a backstop, not the main path: the app fills the cache whenever
  /// it runs (`TopShelfMaintainer`), which is what makes the shelf appear
  /// promptly. A cold refresh from in here is a collections call plus a cover
  /// lookup and a preview download per entry, which does not reliably finish
  /// in the couple of seconds a provider ought to take — so it gets a longer
  /// budget, and on expiry we answer with whatever is cached (on a genuinely
  /// first run, nothing, and tvOS shows the app icon).
  private static let refreshDeadline: Duration = .seconds(12)

  override func loadTopShelfContent() async -> (any TVTopShelfContent)? {
    guard let session = await TopShelfSession.current(),
      let cache = TopShelfCache(server: session.server, libraryID: session.libraryID)
    else { return nil }

    let manifest = await cache.loadManifest()
    if let manifest, !cache.isStale(manifest) {
      return content(from: manifest, cache: cache)
    }

    // Stale or absent. Refresh under a deadline, then answer with whatever
    // the cache holds — the refreshed manifest if it landed, the old one if
    // it didn't.
    do {
      await withDeadline(Self.refreshDeadline) {
        _ = await TopShelfRefresher.run(
          libraryID: session.libraryID,
          generatedSearch: session.generatedSearch,
          search: session.search,
          thumbs: session.thumbs,
          cache: cache
        )
      }
    }

    guard let current = await cache.loadManifest() ?? manifest else { return nil }
    return content(from: current, cache: cache)
  }

  /// Build the carousel. `.details` rather than `.actions` so each item shows
  /// its title and photo count next to the image; with `.actions` the memory
  /// would be an unlabelled photo.
  private func content(from manifest: TopShelfManifest, cache: TopShelfCache)
    -> (any TVTopShelfContent)?
  {
    let items = manifest.entries.compactMap { entry -> TVTopShelfCarouselItem? in
      let imageURL = cache.imageURL(for: entry)
      // An entry whose image is missing is skipped rather than shown blank —
      // a grey tile on the Home screen reads as a broken app.
      guard FileManager.default.fileExists(atPath: imageURL.path) else { return nil }

      let item = TVTopShelfCarouselItem(identifier: entry.id)
      item.contextTitle = entry.title
      item.summary = entry.subtitle
      item.setImageURL(imageURL, for: .screenScale1x)
      item.setImageURL(imageURL, for: .screenScale2x)
      item.displayAction = TVTopShelfAction(url: Self.deepLink(for: entry, in: manifest))
      return item
    }

    guard !items.isEmpty else { return nil }
    return TVTopShelfCarouselContent(style: .details, items: items)
  }

  /// Memories deep-link to themselves; recents only open the app, since a
  /// single photo has no screen of its own to land on that the viewer asked
  /// for. `MapleTVApp` handles both, and treats an unknown memory id as
  /// "open Memories" — the shelf can legitimately be showing a collection the
  /// server has since retired.
  private static func deepLink(for entry: TopShelfEntry, in manifest: TopShelfManifest) -> URL {
    if manifest.isFallback {
      return TVDeepLink.memories.url
    }
    return TVDeepLink.memory(id: entry.id).url
  }
}

/// Run `work`, giving up on it after `duration`.
///
/// The losing branch is cancelled, so an abandoned refresh stops fetching
/// rather than running on inside a process that has already answered.
private func withDeadline(_ duration: Duration, _ work: @escaping @Sendable () async -> Void) async
{
  await withTaskGroup(of: Void.self) { group in
    group.addTask { await work() }
    group.addTask { try? await Task.sleep(for: duration) }
    await group.next()
    group.cancelAll()
  }
}
