// AppShell+RawJpegStack.swift — reloads the open grids when 'Show one image for RAW+JPEG pairs'
// changes (#5050), so the pair folds or splits without a manual refresh.

import MapleCore
import SwiftUI

extension AppShell {
  func reloadForRawJpegStackChange() {
    Task { await browseVM.retryLastLoad() }
    #if os(iOS)
      reloadPhoneLevelsForRawJpegStackChange()
    #endif
  }
}
