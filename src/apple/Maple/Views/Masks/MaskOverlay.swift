// Coverage and selected-component handles follow the live canvas's crop,
// straighten, zoom and pan. Colour-range refinement remains in the vectorscope.
import MapleCore
import SwiftUI

struct MaskOverlay: View {
  @Bindable var state: EditorState
  @State private var previewImage: CGImage?
  @State private var previewGeneration: UInt64 = 0

  private struct CoverageRequest: Hashable {
    let mask: LocalMask?
    let width: Double
    let height: Double
    let adjusting: Bool
  }
  private var request: CoverageRequest {
    CoverageRequest(
      mask: state.session.selectedMaskLayer?.mask,
      width: state.session.nativeImageSize.width, height: state.session.nativeImageSize.height,
      adjusting: state.session.isAdjustingMask)
  }

  var body: some View {
    GeometryReader { geo in
      if let frame = state.zoom.displayFrameInPoints,
        let full = MaskOverlayGeometry.fullFrameRect(
          containerSize: geo.size, displayFrame: frame,
          panOffset: state.zoom.panOffset, crop: state.session.model.crop)
      {
        ZStack {
          if let previewImage {
            let shown = state.session.showsMaskOverlay
            let display = MaskOverlayGeometry.displayRect(
              containerSize: geo.size, displayFrame: frame, panOffset: state.zoom.panOffset)
            ZStack {
              Image(decorative: previewImage, scale: 1)
                .resizable()
                .renderingMode(.template)
                .foregroundStyle(.red.opacity(0.45))
                .frame(width: full.width, height: full.height)
                .rotationEffect(.degrees(state.session.model.crop.angle))
                .position(x: full.midX, y: full.midY)
                .opacity(shown ? 1 : 0)
                .animation(.easeInOut(duration: 0.12), value: shown)
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .mask {
              Rectangle().frame(width: display.width, height: display.height)
                .position(x: display.midX, y: display.midY)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
          }
          MaskGeometryHandles(state: state, fullFrame: full)
        }
        .frame(width: geo.size.width, height: geo.size.height)
        .clipped()
      }
    }
    .task(id: request) { await loadCoverage() }
  }

  @MainActor
  private func loadCoverage() async {
    previewGeneration &+= 1
    let generation = previewGeneration
    let current = request
    guard let mask = current.mask else {
      previewImage = nil
      return
    }
    // Mask drags hide the tint. Wait until their undo transaction closes
    // rather than allocating a coverage image on each pointer move.
    guard !state.session.isAdjustingMask else { return }
    previewImage = nil
    let image = await state.session.maskCoveragePreview(for: mask)
    guard !Task.isCancelled, generation == previewGeneration, current == request else { return }
    previewImage = image
  }
}
