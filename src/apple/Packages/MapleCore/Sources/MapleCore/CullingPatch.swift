// CullingPatch.swift — the culling fields a user changed before the session's
// sidecar finished loading (#4708). Applied over the loaded on-disk culling so
// an early rating replaces only the rating, never the saved state around it.

import Foundation

struct CullingPatch: Equatable, Sendable {
  var stars: Int?
  var flag: CullFlag?
  var hidden: Bool??
  var colorLabel: ColorLabel??
  var keywords: [String]?

  init(from old: CullingState, to new: CullingState) {
    stars = old.stars == new.stars ? nil : new.stars
    flag = old.flag == new.flag ? nil : new.flag
    hidden = old.hidden == new.hidden ? nil : .some(new.hidden)
    colorLabel = old.colorLabel == new.colorLabel ? nil : .some(new.colorLabel)
    keywords = old.keywords == new.keywords ? nil : new.keywords
  }

  func merging(_ later: CullingPatch) -> CullingPatch {
    var merged = self
    merged.stars = later.stars ?? stars
    merged.flag = later.flag ?? flag
    merged.hidden = later.hidden ?? hidden
    merged.colorLabel = later.colorLabel ?? colorLabel
    merged.keywords = later.keywords ?? keywords
    return merged
  }

  func applied(to base: CullingState) -> CullingState {
    CullingState(
      stars: stars ?? base.stars,
      flag: flag ?? base.flag,
      keywords: keywords ?? base.keywords,
      hidden: hidden ?? base.hidden,
      colorLabel: colorLabel ?? base.colorLabel)
  }
}
