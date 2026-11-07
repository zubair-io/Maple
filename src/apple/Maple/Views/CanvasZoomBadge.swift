import MapleCore
import SwiftUI

/// The viewport's zoom readout is also the pointer/touch route through the
/// named zoom stops: each tap advances fit → fill → 100% → fit (#5710).
struct CanvasZoomBadge: View {
  let scale: CGFloat
  let canvasReady: Bool
  let nextStop: CanvasZoomModel.ZoomStop
  let onAdvance: () -> Void

  var body: some View {
    Button(action: onAdvance) {
      Text(FullImageViewVM.zoomPercentLabel(for: scale))
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(.white)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: MapleTokens.Radius.xs))
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!canvasReady)
    .padding(8)
    .help(Self.actionTitle(for: nextStop))
    .accessibilityLabel(Self.actionTitle(for: nextStop))
    .accessibilityValue(FullImageViewVM.zoomAccessibilityLabel(for: scale))
    .accessibilityIdentifier("canvas-zoom-indicator")
  }

  static func actionTitle(for stop: CanvasZoomModel.ZoomStop) -> String {
    switch stop {
    case .fit: "Zoom to Fit"
    case .fill: "Zoom to Fill"
    case .actualSize: "Actual Size"
    }
  }
}
