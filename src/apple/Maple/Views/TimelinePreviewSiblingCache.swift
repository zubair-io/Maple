// TimelinePreviewSiblingCache.swift — #4714.
//
// `PhoneTabShell` asks for the Timeline sibling list on every redraw and
// every build minted fresh `AssetRef.id`s, so Preview's shown asset could
// no longer be found by id and swipes snapped back. The list is rebuilt
// only when the Timeline content it was derived from changes.

import Foundation
import MapleCore

@MainActor
final class TimelinePreviewSiblingCache {
  struct Key: Equatable {
    let fingerprint: Int
  }

  private var cached: (key: Key, assets: [AssetRef])?

  func assets(for key: Key, build: () -> [AssetRef]) -> [AssetRef] {
    if let cached, cached.key == key { return cached.assets }
    let built = build()
    cached = (key, built)
    return built
  }
}
