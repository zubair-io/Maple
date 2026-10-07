// Coverage and selected-component handles follow the live canvas's crop,
// straighten, zoom and pan. Colour-range refinement remains in the vectorscope.
// A selected brush layer (#360) puts a stroke-capture surface over the
// frame instead of handles: press-move-release paints one undo entry, and
// the tint redraws per segment (a brush stroke hides nothing while it
// grows, unlike a slider drag).
import MapleCore
import SwiftUI

struct MaskOverlay: View {
  @Bindable var state: EditorState
  @State private var previewImage: CGImage?
  @State private var previewGeneration: UInt64 = 0
  @State private var strokeSmoother: StrokeSmoother?
  @State private var strokeLast: MaskPoint?

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
          if case .brush = state.session.selectedMaskGeometry, !state.session.showingOriginal {
            Rectangle()
              .fill(.clear)
              .contentShape(Rectangle())
              .frame(width: full.width, height: full.height)
              .position(x: full.midX, y: full.midY)
              .gesture(strokeGesture(fullFrame: full))
              .accessibilityIdentifier("editor-mask-brush-canvas")
              .accessibilityLabel("Brush canvas")
          }
        }
        .frame(width: geo.size.width, height: geo.size.height)
        .coordinateSpace(name: "maskBrushCanvas")
        .clipped()
        .onDisappear { finishStroke() }
        .onChange(of: state.session.selectedMaskId) { _, _ in finishStroke() }
      }
    }
    .task(id: request) { await loadCoverage() }
  }

  private func normalized(_ point: CGPoint, fullFrame: CGRect) -> MaskPoint {
    let p = MaskHandleGeometry.normalizedPoint(
      point, fullFrame: fullFrame, angleDegrees: state.session.model.crop.angle)
    return MaskPoint(x: min(1, max(0, p.x)), y: min(1, max(0, p.y)))
  }

  private func strokeGesture(fullFrame: CGRect) -> some Gesture {
    DragGesture(minimumDistance: 0, coordinateSpace: .named("maskBrushCanvas"))
      .onChanged { value in
        guard case .brush = state.session.selectedMaskGeometry else { return }
        let at = normalized(value.location, fullFrame: fullFrame)
        if strokeSmoother == nil {
          let smoother = StrokeSmoother()
          strokeSmoother = smoother
          let start = smoother.reset(at)
          strokeLast = start
          state.session.beginBrushStroke()
          stampStroke(from: start, to: start)
        } else if let last = strokeLast {
          let next = strokeSmoother?.next(at) ?? at
          strokeLast = next
          stampStroke(from: last, to: next)
        }
      }
      .onEnded { _ in finishStroke() }
  }

  /// Lay the pointer segment's dabs onto the stroke (a tap stamps one).
  /// Pressure reads full: `DragGesture` carries none (a future Pencil
  /// path can thread it through `applyPressure`).
  private func stampStroke(from: MaskPoint, to: MaskPoint) {
    let session = state.session
    let tip = session.brushTip
    let size = session.nativeImageSize
    let aspect = size.height > 0 ? size.width / size.height : 1
    let pressed = BrushRaster.applyPressure(radius: tip.size, weight: tip.flow, pressure: 0)
    session.appendBrushDabs(
      BrushRaster.interpolateDabs(
        from: from, to: to, aspect: aspect, radius: pressed.radius, feather: tip.feather,
        weight: pressed.weight, erase: tip.erase))
  }

  private func finishStroke() {
    guard strokeSmoother != nil else { return }
    strokeSmoother = nil
    strokeLast = nil
    state.session.endBrushStroke()
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
