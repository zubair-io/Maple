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
        .padding(state.armedTool == .crop ? cropInsets(in: geometry.size) : EdgeInsets())
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

  /// Keep crop handles in the uncovered canvas while the shared controls
  /// remain visible. The host and overlay receive these same bounds.
  private func cropInsets(in size: CGSize) -> EdgeInsets {
    let margin = Self.cropViewportMargin
    let coveredWidth = wheelExclusionFrame.map { max(0, size.width - $0.minX) } ?? 0
    let coveredHeight = wheelExclusionFrame.map { max(0, size.height - $0.minY) } ?? 0
    return EdgeInsets(
      top: 76,
      leading: isRegular && hasFilmstrip ? 112 : margin,
      bottom: isRegular ? margin : max(margin, coveredHeight + 16),
      trailing: isRegular ? max(margin, coveredWidth + 16) : margin
    )
  }
}
