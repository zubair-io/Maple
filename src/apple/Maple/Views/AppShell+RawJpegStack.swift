// AppShell+RawJpegStack.swift — reloads the open grids, Timelines and search when 'Show one image
// for RAW+JPEG pairs' changes (#5050), so the pair folds or splits without a manual refresh and no
// view keeps refs that carry (or drop) a JPEG under the old value.

import MapleCloudKit
import MapleCore
import SwiftUI

extension AppShell {
  func reloadForRawJpegStackChange() {
    Task { await browseVM.retryLastLoad() }
    let cloudTimelineVM = cloudTimelineVM
    let allSourcesTimelineVM = allSourcesTimelineVM
    Task {
      // A Timeline no view model holds right now (folder browsing clears them) keeps its folded
      // pages on disk, and its next load paints them before it revalidates.
      await CloudPagesCache().clearAll()
      await cloudTimelineVM?.reloadForStackingChange()
      await allSourcesTimelineVM?.reloadForStackingChange()
    }
    if let searchVM {
      Task { await searchVM.refreshForStackingChange() }
    }
    #if os(iOS)
      reloadPhoneLevelsForRawJpegStackChange()
    #endif
  }
}
