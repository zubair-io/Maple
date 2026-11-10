// PreviewCanvasPage.swift — one Preview page (#5762).
//
// The visible page draws its photo through the editor's shared canvas: the
// same `CanvasZoomHost` zoom (pinch, double-tap fit ↔ 100%, the badge, the
// wheel), laid out at the still's aspect until the real size is known. It
// shows the page's stills — the thumbnail, then the display tier — in the
// photo's frame, and renders the RAW only once the photo is zoomed past the
// still's resolution, so opening and paging never decode. The GPU canvas
// mounts with the render: a placeholder drawn at viewport resolution would
// be softer than the still it covers once zoomed in, and nothing the render
// draws covers the still before it is at least as sharp (#5768). A
// neighbouring page, and a visible one whose session is not primed yet, is
// the still alone, at the same fit rect.

import CoreImage
import MapleCore
import MapleUI
import SwiftUI

extension EnvironmentValues {
  /// The editor is pushed over Preview and drives the photo's session.
  @Entry var previewCanvasIsCovered = false
}

struct PreviewCanvasPage: View {
  let loader: PreviewStillLoader
  /// Set on the visible page once its session is primed.
  let zoom: CanvasZoomController?
  let isVisible: Bool
  var paging: CanvasPagingHooks? = nil

  @Environment(\.displayScale) private var displayScale
  @Environment(\.previewCanvasIsCovered) private var isCovered
  @State private var showsSpinner = false
  @State private var pageSize: CGSize = .zero
  @State private var stillDragInProgress = false
  @GestureState private var stillDragLive = false
  private static let spinnerDelay: Duration = .milliseconds(250)

  var body: some View {
    ZStack {
      if let zoom {
        canvas(zoom)
      } else {
        plainStill
      }
      statusView
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .contentShape(Rectangle())
    .onGeometryChange(for: CGSize.self, of: \.size) { pageSize = $0 }
    .task(id: loader.reloadKey) {
      loader.prepare(for: loader.reloadKey)
      await loader.loadFirstPaint(displayTierDimension: displayTierDimension, isVisible: isVisible)
    }
    .task(
      id: DisplayTierKey(
        reload: loader.reloadKey, isVisible: isVisible, measured: pageSize != .zero)
    ) {
      guard isVisible, pageSize != .zero else { return }
      loader.prepare(for: loader.reloadKey)
      await loader.loadDisplayTier(maxDimension: displayTierDimension)
    }
    .task(id: loader.reloadKey) {
      showsSpinner = false
      try? await Task.sleep(for: Self.spinnerDelay)
      guard !Task.isCancelled, loader.image == nil, loader.phase == .loading else { return }
      showsSpinner = true
    }
  }

  private struct DisplayTierKey: Equatable {
    let reload: String
    let isVisible: Bool
    let measured: Bool
  }

  /// The display tier is asked for at the screen's resolution, within the
  /// sizes the sources cache (#5432).
  private var displayTierDimension: CGFloat {
    let points = max(pageSize.width, pageSize.height, 1)
    return min(4_096, max(2_048, points * displayScale))
  }

  // MARK: - The still alone

  private var plainStill: some View {
    fitStill
      .gesture(stillPagingDrag, including: paging == nil ? .none : .all)
      .onChange(of: stillDragLive) { _, live in
        guard !live, stillDragInProgress else { return }
        stillDragInProgress = false
        paging?.cancelled()
      }
  }

  @ViewBuilder
  private var fitStill: some View {
    if let image = loader.image {
      stillImage(image)
        .aspectRatio(contentMode: .fit)
    }
  }

  /// The visible page before its session is primed still pages and pulls.
  private var stillPagingDrag: some Gesture {
    DragGesture(minimumDistance: 1, coordinateSpace: .global)
      .updating($stillDragLive) { _, live, _ in live = true }
      .onChanged { value in
        stillDragInProgress = true
        paging?.changed(stillFrame(value.translation))
      }
      .onEnded { value in
        stillDragInProgress = false
        paging?.ended(
          .init(
            frame: stillFrame(value.translation),
            predictedUnabsorbed: value.predictedEndTranslation.width,
            velocity: value.velocity, shownRect: fitRect))
      }
  }

  private var fitRect: CGRect? {
    loader.image.map {
      PreviewViewVM.fitRect(
        imageSize: CGSize(width: $0.width, height: $0.height),
        in: CGRect(origin: .zero, size: pageSize))
    }
  }

  private func stillFrame(_ translation: CGSize) -> CanvasPagingHooks.Frame {
    .init(
      translation: translation, unabsorbed: translation.width, isZoomedIn: false,
      isPinching: false)
  }

  private func stillImage(_ image: CGImage) -> some View {
    Image(decorative: image, scale: 1)
      .resizable()
      .interpolation(.high)
  }

  // MARK: - The shared canvas

  private func canvas(_ zoom: CanvasZoomController) -> some View {
    CanvasZoomHost(
      controller: zoom,
      doubleTapBehavior: .toggleFitAnd100,
      canvasReady: loader.image != nil || zoom.session.effectiveImageSize != .zero,
      paging: paging,
      canvasLeaf: { leaf(zoom) },
      // Before the canvas knows its viewport, the still a neighbour showed
      // stays where it was.
      fallback: { fitStill }
    )
    .onChange(of: StillKey(zoom: zoom, still: loader.image), initial: true) {
      guard let still = loader.image else { return }
      zoom.setProvisionalImageSize(
        EditorCanvasSeed.provisionalImageSize(
          forSeedOfPixelSize: CGSize(width: still.width, height: still.height)))
    }
    .onChange(of: RenderGate(zoom: zoom, loader: loader, isCovered: isCovered), initial: true) {
      updateRender(zoom)
    }
  }

  private struct StillKey: Equatable {
    let zoom: ObjectIdentifier
    let still: ObjectIdentifier?

    init(zoom: CanvasZoomController, still: CGImage?) {
      self.zoom = ObjectIdentifier(zoom)
      self.still = still.map(ObjectIdentifier.init)
    }
  }

  /// What the decision to start or hold the render reads.
  private struct RenderGate: Equatable {
    let frame: CanvasShownFrame
    let extent: CGSize
    let stillLongEdge: CGFloat
    let stillSettled: Bool
    let isCovered: Bool

    @MainActor init(zoom: CanvasZoomController, loader: PreviewStillLoader, isCovered: Bool) {
      frame = zoom.restingFrame
      extent = zoom.context.nativeImageSize
      stillLongEdge = loader.longEdgePixels
      stillSettled = loader.isDisplayTierSettled
      self.isCovered = isCovered
    }
  }

  /// Covered by the editor, the canvas lets go of the session. Otherwise it
  /// renders once zoomed past a still that will not soon get sharper.
  private func updateRender(_ zoom: CanvasZoomController) {
    guard !isCovered else { return zoom.stopRenderingSession() }
    guard !zoom.rendersSession, loader.isDisplayTierSettled,
      zoom.showsMoreThanStill(ofLongEdge: loader.longEdgePixels)
    else { return }
    // The GPU canvas about to mount brings a new, empty layer; a frame the
    // editor's layer presented must not reveal it before it presents.
    if usesGpuCanvas(zoom.session) { zoom.session.canvasLayerReplaced() }
    zoom.startRenderingSession()
    if !usesGpuCanvas(zoom.session) { zoom.session.ensureRenderStarted() }
  }

  private func usesGpuCanvas(_ session: EditSession) -> Bool {
    FullImageViewVM.shouldPresentViaGpuCanvas(
      flagEnabled: GpuLiveFlag.isEnabled, isRaw: session.asset.isRaw,
      showingOriginal: session.showingOriginal, presentFailed: session.gpuPresentFailed)
  }

  /// The still beneath and, once rendering, the GPU canvas over it (whose
  /// controller starts the render; hidden until its frame is at least as
  /// sharp as the still), the render's CPU frame when that one is, and the
  /// native-resolution detail patch.
  private func leaf(_ zoom: CanvasZoomController) -> some View {
    let session = zoom.session
    let rendering = zoom.rendersSession
    let gpu = usesGpuCanvas(session)
    let cpuFrameLongEdge =
      session.renderedPreview.map { max($0.extent.width, $0.extent.height) } ?? 0
    let cover = PreviewCanvasRender.cover(
      usesGpu: gpu, gpuFramePresented: session.gpuFramePresented,
      gpuFrameLongEdgePixels: session.gpuFrameLongEdgePixels,
      isFullQualityDecoding: session.isFullQualityDecoding,
      cpuFrameLongEdgePixels: cpuFrameLongEdge, stillLongEdgePixels: loader.longEdgePixels)
    return ZStack {
      if let image = loader.image {
        stillImage(image)
      }
      if rendering, gpu {
        GpuLiveCanvasView(session: session)
          .id(ObjectIdentifier(session))
          .opacity(cover == .gpuFrame ? 1 : 0)
      }
      if rendering, cover == .cpuFrame, let preview = session.renderedPreview {
        CanvasImageView(image: preview)
          .equatable()
          .allowsHitTesting(false)
      }
      if rendering, session.pixelScale >= 1, let detail = session.nativeDetailPreview,
        !session.nativeDetailSourceRect.isEmpty, session.nativeImageSize.width > 0,
        session.nativeImageSize.height > 0
      {
        NativeDetailOverlay(
          image: detail, sourceRect: session.nativeDetailSourceRect,
          sourceSize: session.nativeImageSize)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(session.asset.displayName))
  }

  // MARK: - Loading and failure

  @ViewBuilder
  private var statusView: some View {
    if loader.image == nil, zoom?.session.renderedPreview == nil {
      if loader.phase == .failed {
        MuiIcon(name: "photo", size: .xl)
          .font(.system(size: 56))
          .foregroundStyle(ProTokens.textDim)
          .accessibilityIdentifier("preview-image-failed")
      } else if showsSpinner {
        ProgressView()
          .controlSize(.large)
          .accessibilityIdentifier("preview-image-loading")
      }
    }
  }
}
