// Frame publication and decode progress invalidate this leaf, not editor chrome.
import MapleCore
import SwiftUI

struct EditorRenderStatus: View {
  let session: EditSession

  var body: some View {
    ZStack {
      if let denoise = session.deepDenoiseProgress.progress {
        VStack(spacing: 8) {
          ProgressView(value: denoise.fraction)
            .progressViewStyle(.linear)
            .frame(maxWidth: 240)
            .accessibilityIdentifier("editor-deep-denoise-progress")
            .accessibilityValue(Text("\(Int(denoise.fraction * 100)) percent"))
          Text("Deep denoise — pass \(denoise.pass) of 2")
            .font(.caption)
            .foregroundStyle(MapleTokens.textMuted)
        }
        .padding(20)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
      }
    }
    .allowsHitTesting(false)
  }
}

/// Isolates first-frame observations from the rest of the editor header.
struct EditorHistogramChip: View {
  let session: EditSession

  var body: some View {
    ZStack {
      if showsLoadingIndicator {
        IndeterminateLoadingBar()
          .padding(.horizontal, 8)
      } else {
        MiniHistogram(session: session)
      }
    }
    .frame(maxWidth: 140)
    .frame(height: 26)
    .padding(.horizontal, 12)
    .allowsHitTesting(false)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-pill-histogram")
  }

  private var showsLoadingIndicator: Bool {
    let gpuActive = FullImageViewVM.shouldPresentViaGpuCanvas(
      flagEnabled: GpuLiveFlag.isEnabled,
      isRaw: session.asset.isRaw,
      showingOriginal: session.showingOriginal,
      presentFailed: session.gpuPresentFailed
    )
    return EditSession.shouldShowLoadingIndicator(
      isResolvingFirstFrame: session.isResolvingFirstFrame,
      isRendering: session.isRendering,
      hasOnscreenFrame: EditSession.canvasHasFrame(
        gpuActive: gpuActive,
        gpuFramePresented: session.gpuFramePresented,
        hasRenderedPreview: session.renderedPreview != nil,
        renderedPreviewIsFullRender: session.renderedPreviewIsFullRender
      )
    )
  }
}

struct EditorFrameTimeHUD: View {
  let session: EditSession

  var body: some View {
    if GpuLiveFlag.isEnabled, GpuHudFlag.isEnabled,
      let stats = session.gpuLiveDriver?.frameStats
    {
      GpuFrameTimeHud(stats: stats)
    }
  }
}
