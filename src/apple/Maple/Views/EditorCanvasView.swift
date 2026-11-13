// Keep render and crop observations inside the canvas subtree. EditorView
// composes stable child identities and does not observe per-frame state.
import MapleCore
import SwiftUI

struct EditorCanvasView: View {
  @Bindable var state: EditorState
  var filmstripSource: (any ImageSource)? = nil
  var wheelExclusionFrame: CGRect?
  /// Global frames of the chrome floating over the canvas (#5749 visible
  /// area); `nil` until the chrome has reported them (#5769).
  var coverFrames: [CGRect]?
  var hasFilmstrip = false
  /// The seed still drawn as the canvas until real pixels land (#5755).
  var seedStore: EditorSeedStore { state.seed }
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
            canvasReady: canvasIsReady || hasSeed,
            wheelExcludedFrame: wheelExclusionFrame,
            badgeInsets: badgeInsets(in: geometry),
            safeAreaFrame: visibleSafeArea(in: geometry),
            coverFrames: visibleCoverFrames,
            chromeMeasured: coverFrames != nil
          ) {
            canvasLeaf
          } fallback: {
            canvasPlaceholder
              .paddedToVisibleCanvas(
                safeArea: visibleSafeArea(in: geometry), coverFrames: visibleCoverFrames)
          }
          // The GPU canvas draws the seed (#5758); this loads it and lays
          // the canvas out at its aspect until the real size lands.
          seedLoader
          // Download progress over the seed (#2374), in the visible area.
          downloadOverlay
            .paddedToVisibleCanvas(
              safeArea: visibleSafeArea(in: geometry), coverFrames: visibleCoverFrames)
          // Crop overlay (#638): shown while the Crop tool is armed.
          // The canvas renders UNCROPPED under the overlay. Zoom is held at
          // fit while it shows (#5743); a settle onto fit moves it with the
          // photo.
          if state.armedTool == .crop {
            CropOverlay(state: state)
              .modifier(CanvasPresentedOverlayTransform(controller: state.zoom))
          }
          // Mask coverage and handles for the selected component (#3408).
          if state.armedTool == .mask {
            MaskOverlay(state: state)
              .id(ObjectIdentifier(state.session))
          }
          // Heal overlay (#3409): every repair spot's destination disc, plus
          // the selected spot's source disc and the line joining them.
          if state.armedTool == .heal {
            RetouchOverlay(state: state)
          }
          if state.armedTool == .remove {
            RemovalOverlay(state: state)
          }
          if state.whiteBalancePicker.isArmed {
            WhiteBalancePickOverlay(state: state)
              .id(ObjectIdentifier(state.session))
          }
          // Colour-range eyedropper (#362): the mask panel's pick target,
          // same lifetime rule as the WB overlay above.
          if state.maskRangePicker.isArmed {
            MaskRangePickOverlay(state: state)
              .id(ObjectIdentifier(state.session))
          }
          if state.colorCurvePicker.isArmed {
            ColorCurvePickOverlay(state: state)
              .id(ObjectIdentifier(state.session))
          }
        }
        .padding(canvasInsets(size: geometry.size))
        .ignoresSafeArea(edges: isFullBleed(in: geometry) ? .all : [])
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
    .allowsHitTesting(!state.session.isSavingRemoval)
  }

  /// iPad, the open Duo and the Mac draw the photo edge to edge, beneath
  /// the status bar, header and controls, so fit is the whole screen
  /// (#5710). The crop tool keeps its inset canvas so its handles stay
  /// clear of the controls.
  private func isFullBleed(in geometry: GeometryProxy) -> Bool {
    isRegular && state.armedTool != .crop
      && FullBleedCanvas.isAllowed(
        idiom: MapleShellKind.currentIdiom, screen: FullBleedCanvas.screen(of: geometry))
  }

  /// The region clear of the system bars, when the full-bleed canvas runs
  /// beneath them: this view's own frame, which keeps the safe area.
  private func visibleSafeArea(in geometry: GeometryProxy) -> CGRect? {
    isFullBleed(in: geometry) ? geometry.frame(in: .global) : nil
  }

  /// The crop tool keeps its inset canvas; everywhere else the chrome over
  /// the canvas shapes the visible area fit and centring use.
  private var visibleCoverFrames: [CGRect] {
    state.armedTool == .crop ? [] : coverFrames ?? []
  }

  /// The full-bleed canvas reaches the screen corner, so the badge steps
  /// in by the safe area and, when the controls cover the bottom-leading
  /// corner (the portrait inspector and dock), sits just above them.
  private func badgeInsets(in geometry: GeometryProxy) -> EdgeInsets {
    guard isFullBleed(in: geometry) else { return EdgeInsets() }
    let safe = geometry.safeAreaInsets
    let coversBadgeCorner = { (frame: CGRect) in
      frame.minX < Self.badgeClearance && frame.maxY > geometry.size.height - Self.badgeClearance
    }
    let controlsLift =
      wheelExclusionFrame
      .flatMap { coversBadgeCorner($0) ? max(0, geometry.size.height - $0.minY) : nil } ?? 0
    return EdgeInsets(
      top: 0, leading: safe.leading, bottom: safe.bottom + controlsLift, trailing: 0)
  }

  /// The badge's footprint: 44 pt plus its padding, with margin.
  private static let badgeClearance: CGFloat = 80

  /// Only the crop tool insets the canvas. Elsewhere it spans the editor and
  /// the chrome becomes visible-area insets, so showing, hiding or resizing
  /// it never moves a zoomed photo (#5749).
  private func canvasInsets(size: CGSize) -> EdgeInsets {
    guard state.armedTool == .crop else { return EdgeInsets() }
    let controlsAtBottom = EditorCropGeometry.stacksControlsAtBottom(
      size: size, isTablet: EditorCropGeometry.isTabletClass,
      hasFilmstrip: hasFilmstrip, usesVerticalBar: EditorVerticalControlBar.fits(in: size))
    return EditorCropGeometry.insets(
      size: size, controlsFrame: wheelExclusionFrame,
      isRegular: isRegular, hasFilmstrip: hasFilmstrip,
      controlsAtBottom: controlsAtBottom)
  }

}
