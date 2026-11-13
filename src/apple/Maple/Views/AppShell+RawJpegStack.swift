// AppShell+RawJpegStack.swift — reloads the open grids, Timelines and search when 'Show one image
// for RAW+JPEG pairs' changes (#5050), so the pair folds or splits without a manual refresh and no
// view keeps refs that carry (or drop) a JPEG under the old value.

import MapleCore
import SwiftUI

extension AppShell {
  func reloadForRawJpegStackChange() {
    Task { await browseVM.retryLastLoad() }
    if let cloudTimelineVM {
      Task { await cloudTimelineVM.reloadForStackingChange() }
    }
    if let allSourcesTimelineVM {
      Task { await allSourcesTimelineVM.reloadForStackingChange() }
    }
    if let searchVM {
      Task { await searchVM.refreshForStackingChange() }
    }
    #if os(iOS)
      reloadPhoneLevelsForRawJpegStackChange()
    #endif
  }
}
