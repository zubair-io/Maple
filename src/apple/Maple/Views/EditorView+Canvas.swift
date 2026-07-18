// EditorView+Canvas.swift — the canvas-leaf wiring for EditorView, split out
// of EditorView.swift (600-line file budget; same extension-file pattern as
// AppShell+FolderActions.swift / EditSession+Render.swift). Pure relocation;
// no behavior change.
//
// Contains the GPU/CPU leaf branch (with the #1769 a11y label/value sentinel
// contract), the placeholder, and the download-progress overlay. The layer
// composition (canvasLayer) stays in EditorView.swift next to the body;
// `useGpuCanvas`, `canvasIsReady`, `canvasLeaf`, and `canvasPlaceholder` are
// internal (not private) because that composer + the pill header consume them
// across the file boundary.

import SwiftUI
import CoreImage
import MapleCore

extension EditorView {

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
    /// placeholder).  The GPU layer mounts immediately; the CPU leaf
    /// needs a published preview AND `!showingOriginal` — the
    /// before/after "original" view falls back to the placeholder
    /// (review #1).
    var canvasIsReady: Bool {
        useGpuCanvas || (!state.session.showingOriginal && state.session.renderedPreview != nil)
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
        if useGpuCanvas {
            ZStack {
                GpuLiveCanvasView(session: state.session)
                if showCpuBackdrop,
                   let preview = state.session.renderedPreview {
                    // `.equatable()` makes the render-skip contractual
                    // (#2062): SwiftUI does not consult `Equatable`
                    // automatically for an arbitrary `View`-conforming
                    // struct — only `EquatableView`/`.equatable()` opts a
                    // use site into skipping `body` when `==` says nothing
                    // changed, which is what lets `renderedPreview` staying
                    // the same `CIImage` instance across pan/zoom frames
                    // skip the synchronous raster.
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
           state.session.nativeImageSize.height > 0 {
            NativeDetailOverlay(
                image: image,
                sourceRect: state.session.nativeDetailSourceRect,
                sourceSize: state.session.nativeImageSize
            )
        }
    }

    var canvasPlaceholder: some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(MapleTokens.surfaceAlt)
            .aspectRatio(3.0 / 2.0, contentMode: .fit)
            .overlay { downloadOverlay }
            .padding(12)
            .accessibilityIdentifier("editor-canvas-placeholder")
    }

    // MARK: - GPU frame-time HUD (validation-only overlay)

    /// The GPU frame-time HUD overlay (#1053). Renders the HUD only when the GPU
    /// live path is active AND the HUD sub-flag is on (`MAPLE_GPU_HUD=1`); an
    /// `EmptyView` otherwise. Ported from the legacy `FullImageView` when it was
    /// retired in #1807 — this is the only on-device way to confirm a slider
    /// tick renders inside the 16ms budget (device logs aren't capturable on
    /// the paired Artemis), so the editor needed its own mount point.
    @ViewBuilder
    var frameTimeHud: some View {
        if GpuLiveFlag.isEnabled, GpuHudFlag.isEnabled,
           let stats = state.session.gpuLiveDriver?.frameStats {
            GpuFrameTimeHud(stats: stats)
        } else {
            EmptyView()
        }
    }

    /// "4.2 MB / 12 MB" or "4.2 MB" when the total is unknown. Adaptive units
    /// via `ByteCountFormatStyle`, monospaced digits at the call-site keep the
    /// number stable as bytes tick up. Local helper rather than two inline
    /// `.formatted(...)` calls per render — the placeholder re-evaluates on
    /// every `receivedBytes` Observable write, and a one-call hoisted helper
    /// keeps the body terse.
    private func downloadByteCountText(for progress: DownloadProgress) -> String {
        let style = ByteCountFormatStyle(style: .file)
        let received = progress.receivedBytes.formatted(style)
        if let total = progress.expectedBytes, total > 0 {
            return "\(received) / \(total.formatted(style))"
        }
        return received
    }

    /// Speed rendered as "320 KB" / "1.2 MB" — the calling site adds the "/ s"
    /// suffix so a future change to a different cadence label (e.g. "/ min")
    /// only touches that one line. The `Int64` cast clamps NaN / ±∞ /
    /// out-of-range values to 0…Int64.max so a corrupted
    /// `URLResourceValues` read (rare but theoretically possible from a
    /// misbehaving FileProvider extension) can't crash the editor. Real
    /// network rates fit Int64.max by orders of magnitude.
    private func downloadSpeedText(_ bytesPerSecond: Double) -> String {
        let clamped: Int64
        if bytesPerSecond.isNaN || bytesPerSecond <= 0 {
            clamped = 0
        } else if bytesPerSecond >= Double(Int64.max) {
            clamped = .max
        } else {
            clamped = Int64(bytesPerSecond)
        }
        return clamped.formatted(ByteCountFormatStyle(style: .file))
    }

    @ViewBuilder
    private var downloadOverlay: some View {
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
                Text(downloadByteCountText(for: progress))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(MapleTokens.textMuted)
                if let speed = progress.bytesPerSecond {
                    Text("\(downloadSpeedText(speed)) / s")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(MapleTokens.textMuted)
                        .accessibilityIdentifier("editor-download-speed")
                }
            }
            .padding(24)
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
