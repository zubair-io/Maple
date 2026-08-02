// PreviewImage.swift — the still that Preview paints on macOS.
//
// Split out of PreviewView.swift for the file-size budget (#2311 headroom
// gate); no behaviour change. iOS uses `PreviewPager` / `PreviewZoomController`
// instead — see `PreviewView.imageBody` — so this is the desktop path.
//
// Two tiers, both dispatched through `ThumbnailProvider` on the view's
// `ThumbnailSource`: the already-cached grid thumbnail owns first paint, then
// display-resolution pixels swap in once they arrive. Neither boots a render
// session; Preview exists to be free.

import SwiftUI
import MapleCore

// MARK: - PreviewImage

/// Fit-to-screen still image, backed by the shared thumbnail cache. Loads JPEG
/// bytes via `ThumbnailProvider` (the SAME path grid cells + the filmstrip use)
/// on appear and reloads when the source id changes (prev/next). No canvas, no
/// zoom, no session — this is the whole speed point.
///
/// `.task(id:)` owns the lifecycle: it auto-cancels the in-flight load when the
/// id changes or the view disappears (per `docs/best-practices.md` § Swift). A
/// swipe can still fire a new load before the previous resolves, so the result
/// is stale-guarded on `sourceID` before it paints — a superseded load never
/// overwrites the newer image.
struct PreviewImage: View {
    let source: ThumbnailSource
    let provider: ThumbnailProvider
    var onZoomStateChanged: (Bool, Bool) -> Void = { _, _ in }

    /// Display-ready pixels. JPEG decoding must never happen in `body`: when a
    /// PhotoKit request completes during an interactive page transition, doing
    /// ImageIO decode there blocks the main thread and visibly stalls the pager.
    @State private var decodedImage: CGImage?
    @State private var loadedID: String?

    /// What the empty branch should say when there are no pixels yet (#2377).
    /// The old behaviour — a static `photo` glyph — assumed the thumbnail was
    /// already cached and "usually instant". That holds for a warm local
    /// asset; a cloud fetch is network-bound, and a motionless icon read as
    /// "broken" with no way to tell loading from failed.
    private enum LoadPhase { case loading, loaded, failed }
    @State private var phase: LoadPhase = .loading
    /// Gates the spinner behind `spinnerDelay` so the common case — a cached
    /// thumbnail resolving in a frame or two — never flashes one. A spinner
    /// visible for 30ms is worse than no spinner at all.
    @State private var showsSpinner = false
    private static let spinnerDelay: Duration = .milliseconds(250)
    @State private var zoomScale: CGFloat = 1
    @GestureState private var pinchScale: CGFloat = 1

    /// Stable identity for the current source — drives `.task(id:)` reload and
    /// the stale-guard. `ThumbnailSource` isn't Hashable (it carries an
    /// existential source), so key on the asset id we can reach.
    private var sourceID: String {
        if case let .local(ref, _) = source {
            return ref.primaryURL?.absoluteString ?? ref.stableID ?? ref.displayName
        }
        return "\(source)"
    }

    var body: some View {
        ZStack {
            if let cg = decodedImage {
                Group {
                    #if os(macOS)
                    Image(nsImage: NSImage(cgImage: cg, size: .zero))
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                    #else
                    Image(uiImage: UIImage(cgImage: cg))
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                    #endif
                }
                .scaleEffect(effectiveZoom)
                .animation(.interactiveSpring(response: 0.25, dampingFraction: 0.86), value: zoomScale)
            } else if phase == .failed {
                // Terminal: the source returned nothing. Distinct from the
                // loading state above so the two never read as each other.
                Image(systemName: "photo")
                    .font(.system(size: 56))
                    .foregroundStyle(ProTokens.textDim)
                    .accessibilityIdentifier("preview-image-failed")
            } else if showsSpinner {
                ProgressView()
                    .controlSize(.large)
                    .accessibilityIdentifier("preview-image-loading")
            }
            // Below `spinnerDelay` the branch is deliberately empty: the
            // backdrop alone is calmer than a glyph that appears and is gone
            // again before it can be read.
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MapleTokens.bg)
        .clipped()
        .simultaneousGesture(pinchGesture)
        .task(id: sourceID) { await load(for: sourceID) }
        // Separate task so the delay races the load rather than serialising
        // behind it. Cancelled and restarted on every source change.
        .task(id: sourceID) {
            showsSpinner = false
            try? await Task.sleep(for: Self.spinnerDelay)
            guard !Task.isCancelled, phase == .loading else { return }
            showsSpinner = true
        }
        .onChange(of: sourceID) { _, _ in
            zoomScale = 1
            onZoomStateChanged(true, false)
        }
    }

    private func load(for id: String) async {
        // Already showing this source — nothing to do.
        if loadedID == id, decodedImage != nil { return }
        phase = .loading
        guard let data = await provider.thumbnail(for: source) else {
            // Don't strand the view on the spinner: a nil thumbnail is the
            // source's terminal answer, not a slow one.
            if !Task.isCancelled { phase = .failed }
            return
        }
        let image = await Task.detached(priority: .userInitiated) {
            ThumbnailDecoder.decodeFullSync(data)
        }.value
        // Stale-guard: a newer `.task(id:)` supersedes and cancels this one on
        // an id change, so `!Task.isCancelled` is the real check. (`sourceID`
        // is derived from the view's `source` prop; a re-created struct with a
        // new source runs its own fresh task, so a value compare here would be
        // redundant.) Copilot review #1810.
        guard !Task.isCancelled else { return }
        decodedImage = image
        loadedID = id
        phase = image == nil ? .failed : .loaded

        // The tiny cached image owns first paint. Once it is on screen, ask
        // the source for display-sized pixels and swap them in only if this
        // page is still current.
        guard let previewData = await provider.preview(for: source) else { return }
        let enhanced = await Task.detached(priority: .utility) {
            ThumbnailDecoder.decodeFullSync(previewData)
        }.value
        guard !Task.isCancelled, let enhanced else { return }
        decodedImage = enhanced
    }

    private var effectiveZoom: CGFloat {
        min(6, max(1, zoomScale * pinchScale))
    }

    private var pinchGesture: some Gesture {
        MagnifyGesture()
            .onChanged { _ in
                onZoomStateChanged(false, true)
            }
            .updating($pinchScale) { value, state, _ in
                state = value.magnification
            }
            .onEnded { value in
                zoomScale = min(6, max(1, zoomScale * value.magnification))
                onZoomStateChanged(zoomScale == 1, false)
            }
    }
}
