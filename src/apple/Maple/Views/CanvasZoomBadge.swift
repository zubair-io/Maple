import SwiftUI

/// The viewport's zoom readout is also the pointer/touch route back to fit.
struct CanvasZoomBadge: View {
  let scale: CGFloat
  let canvasReady: Bool
  let onFit: () -> Void

  var body: some View {
    Button(action: onFit) {
      Text(FullImageViewVM.zoomPercentLabel(for: scale))
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(.white)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: MapleTokens.Radius.xs))
    }
    .buttonStyle(.plain)
    .disabled(!canvasReady)
    .padding(8)
    .help("Zoom to Fit (⌘0)")
    .accessibilityLabel("Zoom to Fit")
    .accessibilityValue(FullImageViewVM.zoomAccessibilityLabel(for: scale))
    .accessibilityIdentifier("canvas-zoom-indicator")
  }
}
