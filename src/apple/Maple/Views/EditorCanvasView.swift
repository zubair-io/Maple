// Keep render and crop observations inside the canvas subtree.
import MapleCore
import SwiftUI

struct EditorCanvasView: View {
  @Bindable var state: EditorState
  var filmstripSource: (any ImageSource)? = nil
  var wheelExclusionFrame: CGRect?
  var hasFilmstrip = false
  @Environment(\.mapleLayout) private var layout
  private var isRegular: Bool { layout != .phone }

  // MARK: - Canvas layer

  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .top) {
        ZStack(alignment: .top) {
          CanvasZoomHost(
            controller: state.zoom,
            doubleTapBehavior: .toggleFitAnd100,
            onWheelEditing: { steps, unit in
              state.wheelNudge(steps: steps, unit: unit)
            },
            canvasReady: canvasIsReady,
            wheelExcludedFrame: wheelExclusionFrame
          ) {
            canvasLeaf
          } fallback: {
            canvasPlaceholder
          }
          // Seed thumbnail until real pixels land, then the download
          // progress above it (#2374).
          seedThumbnail
          downloadOverlay
          // Crop overlay (#638): shown while the Crop tool is armed.
          // The canvas renders UNCROPPED under the overlay.
          if state.armedTool == .crop {
            CropOverlay(state: state)
          }
          if state.armedTool == .mask {
            MaskOverlay(state: state)
          }
          if state.whiteBalancePicker.isArmed {
            WhiteBalancePickOverlay(state: state)
              .id(ObjectIdentifier(state.session))
          }
        }
        .padding(
          state.armedTool == .crop
            ? EditorCropGeometry.insets(
              size: geometry.size, controlsFrame: wheelExclusionFrame,
              isRegular: isRegular, hasFilmstrip: hasFilmstrip) : EdgeInsets())
        // Before/after "BEFORE" badge — surfaced while the session is
        // showing the original (the canvas itself falls back to the
        // placeholder).
        if state.session.showingOriginal {
          VStack {
            Spacer()
            Text("BEFORE")
              .font(.caption.bold())
              .foregroundStyle(.white)
              .padding(6)
              .background(.black.opacity(0.6), in: Capsule())
              .padding(.bottom, 12)
          }
          .allowsHitTesting(false)
          .accessibilityIdentifier("editor-before-badge")
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(MapleTokens.bg)
      .contentShape(Rectangle())
      // Render-path badge and zoom % have moved to PillHeader — the
      // bottom-trailing GPU/CPU overlay is no longer rendered here.
    }
  }

}
