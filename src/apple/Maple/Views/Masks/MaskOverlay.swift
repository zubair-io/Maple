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

  private struct CoverageRequest: Hashable {
    let mask: LocalMask?
    let width: Double
    let height: Double
    let crop: Crop
    let perspective: Perspective
    let adjusting: Bool
  }
  private var request: CoverageRequest {
    CoverageRequest(
      mask: state.session.selectedMaskLayer?.mask,
      width: state.session.nativeImageSize.width, height: state.session.nativeImageSize.height,
      crop: state.session.model.crop, perspective: state.session.model.perspective,
      adjusting: state.session.isAdjustingMask)
  }

  var body: some View {
    GeometryReader { geo in
      // The photo as shown — a live pinch or a settle included — so the
      // tint and handles move with it in the same frame (#5744).
      CanvasPresentedReader(controller: state.zoom) { presented in
        if let presented {
          let display = MaskOverlayGeometry.displayRect(
            containerSize: geo.size, displayFrame: presented.displayFrame,
            panOffset: presented.panOffset)
          let projection = MaskProjection.presentationToFrame(
            crop: state.session.model.crop, perspective: state.session.model.perspective,
            nativeSize: state.session.nativeImageSize)
          overlay(in: geo.size, display: display, projection: projection)
        }
      }
    }
    .task(id: request) { await loadCoverage() }
  }

  private func overlay(
    in size: CGSize, display: CGRect, projection: MaskProjection
  ) -> some View {
    ZStack {
      if let previewImage {
        let shown = state.session.showsMaskOverlay
        Image(decorative: previewImage, scale: 1)
          .resizable()
          .renderingMode(.template)
          .foregroundStyle(.red.opacity(0.45))
          .frame(width: display.width, height: display.height)
          .position(x: display.midX, y: display.midY)
          .opacity(shown ? 1 : 0)
          .animation(.easeInOut(duration: 0.12), value: shown)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
      MaskGeometryHandles(state: state, displayRect: display, projection: projection)
      if case .brush = state.session.selectedMaskGeometry, !state.session.showingOriginal {
        Rectangle()
          .fill(.clear)
          .contentShape(Rectangle())
          .frame(width: display.width, height: display.height)
          .position(x: display.midX, y: display.midY)
          .gesture(strokeGesture(displayRect: display, projection: projection))
          .accessibilityIdentifier("editor-mask-brush-canvas")
          .accessibilityLabel("Brush canvas")
      }
    }
    .frame(width: size.width, height: size.height)
    .coordinateSpace(name: "maskBrushCanvas")
    .clipped()
    .onDisappear { finishStroke() }
    .onChange(of: state.session.selectedMaskId) { _, _ in finishStroke() }
  }

  private func normalized(
    _ point: CGPoint, displayRect: CGRect, projection: MaskProjection
  ) -> MaskPoint? {
    MaskOverlayGeometry.normalizedPoint(
      point, displayRect: displayRect, projection: projection)
  }

  private func strokeGesture(displayRect: CGRect, projection: MaskProjection) -> some Gesture {
    DragGesture(minimumDistance: 0, coordinateSpace: .named("maskBrushCanvas"))
      .onChanged { value in
        guard case .brush = state.session.selectedMaskGeometry else { return }
        let at = normalized(value.location, displayRect: displayRect, projection: projection)
        if strokeSmoother == nil {
          guard at != nil else { return }
          strokeSmoother = StrokeSmoother()
          state.session.beginBrushStroke()
        }
        if let segment = strokeSmoother?.segment(to: at) {
          stampStroke(from: segment.from, to: segment.to)
        }
      }
      .onEnded { value in
        // The smoother trails the pointer; land the stroke where it was released.
        let at = normalized(value.location, displayRect: displayRect, projection: projection)
        if let segment = strokeSmoother?.segment(to: at, finishing: true) {
          stampStroke(from: segment.from, to: segment.to)
        }
        finishStroke()
      }
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
