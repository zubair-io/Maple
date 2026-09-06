import MapleCore
import SwiftUI

/// Kept inside CanvasZoomHost, so before pixels get exactly the same crop,
/// scale and pan as after pixels. The comparison belongs to the command scope.
struct EditorOriginalPreview: View {
  @Environment(\.editorCommandRouter) private var router

  var body: some View {
    if let router {
      let comparison = router.comparison
      let request = comparison.request(viewport: router.state.zoom.context.viewportPx)
      ZStack {
        if let image = comparison.image {
          CanvasImageView(image: image).equatable()
        } else if let error = comparison.error {
          Text(error).foregroundStyle(ProTokens.textMuted)
        } else {
          ProgressView("Preparing original")
        }
      }
      .task(id: request) { await comparison.prepare(request) }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Original image")
      .accessibilityValue(
        comparison.error ?? (comparison.image == nil ? "Preparing original" : "Original ready")
      )
      .accessibilityIdentifier("editor-original-preview")
    }
  }
}
