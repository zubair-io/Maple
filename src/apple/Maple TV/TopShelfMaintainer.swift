// src/apple/Maple TV/TopShelfMaintainer.swift
//
// Keeps the Home screen's Top Shelf cache filled from inside the app.
//
// The Top Shelf extension can also fill it, but only under a hard deadline —
// tvOS swaps a slow content provider for the static app icon — and a cold
// fill is a collections call plus a cover lookup and an image download per
// entry, which does not reliably finish in that window. The app has no such
// limit, so it is the reliable filler and the extension is the backstop.
//
// Deliberately fire-and-forget: nothing in the app's UI depends on this, and
// a failure means the shelf shows what it last had (or the app icon), which
// is a perfectly good outcome for a surface the viewer isn't looking at yet.

import Foundation
import MapleCloudKit
import TVServices

enum TopShelfMaintainer {
  /// Refresh the shelf if it is stale, then tell tvOS to reload it.
  ///
  /// Staleness is checked first so that opening the app repeatedly doesn't
  /// re-download the same covers — the shelf's content only changes when the
  /// server's daily memories do.
  static func refreshIfNeeded(session: TVCloudSession, libraryID: String) async {
    guard let cache = TopShelfCache(server: session.server, libraryID: libraryID) else { return }
    guard cache.isStale(await cache.loadManifest()) else { return }

    let wrote = await TopShelfRefresher.run(
      libraryID: libraryID,
      generatedSearch: session.generatedSearchClient,
      search: session.searchClient,
      thumbs: session.thumbClient,
      cache: cache
    )
    if wrote {
      TVTopShelfContentProvider.topShelfContentDidChange()
    }
  }
}
