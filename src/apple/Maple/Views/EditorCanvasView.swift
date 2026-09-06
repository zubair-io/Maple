// Keep render and crop observations inside the canvas subtree. EditorView
// composes stable child identities and does not observe per-frame state.
import MapleCore
import SwiftUI

struct EditorCanvasView: View {
  @Bindable var state: EditorState
  var filmstripSource: (any ImageSource)? = nil
  var wheelExclusionFrame: CGRect?

  // MARK: - Canvas layer

  /// Fit-mode inset applied around the canvas while the Crop tool is
  /// armed. Without it, a full-frame crop's fit footprint touches the
  /// viewport edge on the constraining axis, so a corner/edge handle's
  /// grab tolerance (`CropOverlay`'s `handleTolerance`, 14pt) is
  /// half-clipped by the gesture region instead of fully reachable.
  /// `CanvasZoomHost` and `CropOverlay` each resolve their own fit
  /// footprint from their own `GeometryReader`, so padding this shared
  /// wrapper keeps both reading the same (smaller) size and the overlay
  /// stays 1:1 with the painted image.
  private static let cropViewportMargin: CGFloat = 32

  var body: some View {
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
        // Mask overlay (#3275): the selected bitmap mask's raster,
        // tinted red, while the Mask tool is armed.
        if state.armedTool == .mask {
          MaskOverlay(state: state)
        }
        if state.whiteBalancePicker.isArmed {
          WhiteBalancePickOverlay(state: state)
            .id(ObjectIdentifier(state.session))
        }
      }
      .padding(state.armedTool == .crop ? Self.cropViewportMargin : 0)
      // The comparison leaf and badge share the same latched/held state.
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
    .editorCanvasHitRegion()
  }
}
