// ExportShareSheet.swift — UIKit share sheet for a staged export (#3403).
//
// SwiftUI's `ShareLink` is a button that needs its item up front, but the
// export has to render first — so the panel presents this wrapper once
// `ExportPanelVM.stagedFile` is set. Embedded in a `.sheet`, the activity
// controller needs no popover anchor on iPad.

#if os(iOS)

import SwiftUI
import UIKit

struct ExportShareSheet: UIViewControllerRepresentable {
  let fileURL: URL
  /// Called when the activity controller finishes; `true` when the user
  /// completed an activity, `false` when they cancelled.
  let onFinish: (Bool) -> Void

  func makeUIViewController(context: Context) -> UIActivityViewController {
    let controller = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
    controller.completionWithItemsHandler = { _, completed, _, _ in onFinish(completed) }
    return controller
  }

  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

#endif
