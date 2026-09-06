import CoreImage
import MapleCore
// Canvas content, loading seed, and download progress observation.
import SwiftUI

extension EditorCanvasView {

  // MARK: - Canvas leaf helpers

  var useGpuCanvas: Bool {
    // #1617: cropped frames now present via the GPU live path too — the
    // render layer crops the decoded buffer before the readback, so the
    // canvas no longer forces CPU for a static crop. Crop-EDITING still
    // shows the uncropped full frame (`effectiveCrop` folds in the armed
    // gate and `straightenAngle` drives the live rotation), which this
    // predicate already permits.
    FullImageViewVM.shouldPresentViaGpuCanvas(
      flagEnabled: GpuLiveFlag.isEnabled,
      isRaw: state.session.asset.isRaw,
      showingOriginal: state.session.showingOriginal,
      presentFailed: state.session.gpuPresentFailed
    )
  }

  /// True when the host should render the canvas leaf (vs the
  /// placeholder). GPU and comparison mount immediately and show their
  /// own preparation state; the live CPU leaf needs a published preview.
  var canvasIsReady: Bool {
    state.session.showingOriginal || useGpuCanvas || state.session.renderedPreview != nil
  }

  /// True once real pixels for this asset are actually painted — the GPU
  /// layer has presented a frame, or the CPU path has a rendered preview.
  /// Distinct from `canvasIsReady`, which only says the leaf is MOUNTED
  /// (the GPU leaf mounts before it has anything to show). The cold-open
  /// loading bar and the zoom-to-open thumbnail seed (#1489) both key off
  /// this, so they appear and retire together.
  var canvasHasOnscreenFrame: Bool {
    EditSession.canvasHasFrame(
      gpuActive: useGpuCanvas,
      gpuFramePresented: state.session.gpuFramePresented,
      hasRenderedPreview: state.session.renderedPreview != nil
    )
  }

  private var showCpuBackdrop: Bool {
    state.session.isFullQualityDecoding || !state.session.gpuFramePresented
  }

  private var straightenAngle: Double {
    guard state.armedTool == .crop else { return 0 }
    return state.session.model.crop.angle
  }

  @ViewBuilder
  var canvasLeaf: some View {
    canvasLeafContent
      .rotationEffect(.degrees(straightenAngle))
  }

  @ViewBuilder
  private var canvasLeafContent: some View {
    if state.session.showingOriginal {
      EditorOriginalPreview()
    } else if useGpuCanvas {
      ZStack {
        GpuLiveCanvasView(session: state.session)
        if showCpuBackdrop,
          let preview = state.session.renderedPreview
        {
          // `.equatable()` makes the render-skip contractual
          // (#2062): SwiftUI does not consult `Equatable`
          // automatically for an arbitrary `View`-conforming
          // struct — only `EquatableView`/`.equatable()` opts a
          // use site into skipping `body` when `==` says nothing
          // changed — which is what lets an unchanged
          // `renderedPreview` (the same `CIImage` instance across
          // pan/zoom frames) skip the synchronous raster.
          CanvasImageView(image: preview)
            .equatable()
            .allowsHitTesting(false)
        }
        nativeDetailOverlay
      }
      .accessibilityElement(children: .ignore)
      // The label is REQUIRED for the element to exist on iOS at all: a
      // children-ignored element with no label/traits is pruned from the
      // UIKit accessibility tree, which hid the ready sentinel from the
      // iPad XCUITest harness (#1769). macOS exposes it either way.
      // Also the repo's a11y contract: every element needs a label.
      .accessibilityLabel("Editor canvas")
      // Readiness rides BOTH the identifier (the macOS harness contract)
      // and the VALUE: on iOS the root-level `editor-view` identifier
      // (EditorView.swift, the `.accessibilityElement(children: .contain)`
      // site) clobbers every descendant element's identifier
      // (verified via a11y dump — even `canvas-zoom-indicator` reads
      // `editor-view` there), so the iPad harness matches on
      // label + value instead (#1769).
      .accessibilityValue(
        FullImageViewVM.canvasAccessibilityID(
          isRendering: state.session.isRendering,
          hasPreview: state.session.gpuFramePresented
        )
      )
      .accessibilityIdentifier(
        FullImageViewVM.canvasAccessibilityID(
          isRendering: state.session.isRendering,
          hasPreview: state.session.gpuFramePresented
        )
      )
    } else if let preview = state.session.showingOriginal ? nil : state.session.renderedPreview {
      // CPU path — suppressed while showing the original (review #1),
      // so the before/after toggle falls back to the placeholder.
      ZStack {
        // See the GPU branch above for why `.equatable()` is required
        // (#2062): `Equatable` conformance alone doesn't change
        // SwiftUI's diffing behavior without it.
        CanvasImageView(image: preview)
          .equatable()
        nativeDetailOverlay
      }
      .accessibilityElement(children: .ignore)
      // See the GPU branch: label + value materialize the element
      // and carry the ready sentinel on iOS (#1769).
      .accessibilityLabel("Editor canvas")
      .accessibilityValue(
        FullImageViewVM.canvasAccessibilityID(
          isRendering: state.session.isRendering,
          hasPreview: state.session.renderedPreview != nil
        )
      )
      .accessibilityIdentifier(
        FullImageViewVM.canvasAccessibilityID(
          isRendering: state.session.isRendering,
          hasPreview: state.session.renderedPreview != nil
        )
      )
    }
  }

  @ViewBuilder
  private var nativeDetailOverlay: some View {
    if !state.session.showingOriginal,
      state.session.pixelScale >= 1,
      let image = state.session.nativeDetailPreview,
      !state.session.nativeDetailSourceRect.isEmpty,
      state.session.nativeImageSize.width > 0,
      state.session.nativeImageSize.height > 0
    {
      NativeDetailOverlay(
        image: image,
        sourceRect: state.session.nativeDetailSourceRect,
        sourceSize: state.session.nativeImageSize
      )
    }
  }

  var canvasPlaceholder: some View {
    RoundedRectangle(cornerRadius: MapleTokens.Radius.xs)
      .fill(MapleTokens.surfaceAlt)
      .aspectRatio(3.0 / 2.0, contentMode: .fit)
      .padding(12)
      .accessibilityIdentifier("editor-canvas-placeholder")
  }

  /// The grid thumbnail painted above the canvas leaf / placeholder until
  /// the canvas has real pixels (#2374). Composed in `canvasLayer` so it
  /// sits over the GPU leaf — which mounts opaque before its first frame —
  /// and under the download overlay.
  var seedThumbnail: some View {
    EditorSeedThumbnail(
      asset: state.session.asset,
      source: filmstripSource,
      visible: !state.session.showingOriginal && !canvasHasOnscreenFrame
    )
  }

  /// Byte-download progress for a cloud open (#822). Composed in
  /// `canvasLayer` above the seed thumbnail rather than inside the
  /// placeholder, so it is visible on the GPU path too — there the leaf
  /// mounts immediately and the placeholder never shows (#2374).
  @ViewBuilder
  var downloadOverlay: some View {
    if let progress = state.session.downloadProgress, progress.isDownloading {
      VStack(spacing: 10) {
        if let fraction = progress.fraction {
          ProgressView(value: fraction)
            .progressViewStyle(.linear)
            .frame(maxWidth: 240)
            .accessibilityIdentifier("editor-download-progress")
            .accessibilityValue(Text("\(Int(fraction * 100)) percent"))
        } else {
          ProgressView()
            .progressViewStyle(.linear)
            .frame(maxWidth: 240)
            .accessibilityIdentifier("editor-download-progress")
        }
        Text("Downloading\u{2026}")
          .font(.caption)
          .foregroundStyle(MapleTokens.textMuted)
        // Bytes received / total + running-average speed. Both lines
        // are derived from `DownloadProgress`'s Observable state so
        // they tick alongside the progress bar without a timer.
        Text(
          EditorCanvasViewVM.downloadByteCountText(
            receivedBytes: progress.receivedBytes, expectedBytes: progress.expectedBytes)
        )
        .font(.caption2.monospacedDigit())
        .foregroundStyle(MapleTokens.textMuted)
        if let speed = progress.bytesPerSecond {
          Text("\(EditorCanvasViewVM.downloadSpeedText(speed)) / s")
            .font(.caption2.monospacedDigit())
            .foregroundStyle(MapleTokens.textMuted)
            .accessibilityIdentifier("editor-download-speed")
        }
      }
      .padding(24)
      // `canvasLayer`'s ZStack is top-aligned (the chrome above the
      // canvas depends on it), so a bare child pins to the top edge.
      // Inside the placeholder this used to be an `.overlay`, which
      // centres by default — fill and centre explicitly to keep the
      // progress where it has always been.
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }
  }
}

/// Places a small native-resolution patch inside the full-image canvas leaf.
/// `sourceRect` is top-left-oriented source geometry, matching the zoom
/// controller; SwiftUI's geometry is top-left-oriented too, so placement is a
/// direct normalized mapping. The parent host clips this leaf to the viewport.
private struct NativeDetailOverlay: View {
  let image: CIImage
  let sourceRect: CGRect
  let sourceSize: CGSize

  var body: some View {
    GeometryReader { geometry in
      let size = geometry.size
      let width = size.width * sourceRect.width / sourceSize.width
      let height = size.height * sourceRect.height / sourceSize.height
      let centerX = size.width * sourceRect.midX / sourceSize.width
      let centerY = size.height * sourceRect.midY / sourceSize.height

      // `.equatable()` per #2062 — see the canvas-leaf branches above
      // for why the plain conformance needs this to actually gate
      // `body` re-evaluation.
      CanvasImageView(image: image)
        .equatable()
        .frame(width: width, height: height)
        .position(x: centerX, y: centerY)
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}
