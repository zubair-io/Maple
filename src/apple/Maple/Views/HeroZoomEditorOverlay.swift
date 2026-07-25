// HeroZoomEditorOverlay.swift — Apple-Photos-style zoom-to-open presentation
// for the editor (#1489).
//
// This is an overlay, not a `NavigationStack` push, and that is the whole
// point. A push would have to be dressed with
// `.navigationTransition(.zoom(sourceID:in:))` to get the zoom, and that
// modifier bundles a pinch-to-dismiss the SDK exposes no way to disable
// (verified against iOS 26.4 — `ZoomNavigationTransition` has no
// configuration surface). It beats `CanvasZoomHost`'s pinch even under
// `.highPriorityGesture`, so pinching to zoom into a photo dismissed the
// editor mid-zoom. Presenting from a `ZStack` means no system recognizer is
// installed at all, and every gesture below is one this file owns.
//
// The choreography, in one place:
//
//   progress 0 ─────────────────────────────────────────────► progress 1
//   backdrop   transparent ..................................... opaque
//   editor     hidden ......... fades in from 0.45 ............. opaque
//   flying     over the tile, square-cropped ..... over the canvas fit rect,
//              corner radius 4 ................... un-cropped, radius 0
//
// At progress 1 the flying thumbnail is pixel-coincident with the seed
// thumbnail `EditorView` is drawing, so dropping the flying layer is
// invisible. The editor is mounted (and rendering) for the whole flight, so
// the transition is not blocking the decode — it is covering it.
//
// Close is the same timeline run backwards, driven either by the header's
// back button or, interactively, by an at-fit pinch-in: `CanvasZoomHost`
// hands the magnification here instead of zooming out past fit.

#if os(iOS)

import SwiftUI
import MapleCore

struct HeroZoomEditorOverlay: View {
    /// The asset to open. Already resolved (session + cloud sidecar store
    /// built) by the presenting surface.
    let asset: AssetRef
    /// The tapped tile's thumbnail + geometry. `nil` when the cell had no
    /// thumbnail loaded — the transition degrades to a plain fade.
    let source: PhotoGridHeroSource?
    @Binding var sessions: [AssetRef.ID: EditSession]
    /// Called once the close animation has finished and the overlay can be
    /// torn out of the hierarchy.
    let onClosed: () -> Void

    /// 0 = collapsed onto the source tile, 1 = fully open.
    @State private var progress: CGFloat = 0
    /// The editor's canvas region in global coordinates, reported by
    /// `EditorView`. `.zero` until the first layout pass lands.
    @State private var canvasFrame: CGRect = .zero
    /// This overlay's own global frame, used to convert the source tile's
    /// global rect into local coordinates for `.position`.
    @State private var overlayFrame: CGRect = .zero
    /// Whether the flying thumbnail is mounted. Dropped once the open
    /// animation completes, re-mounted when a close begins.
    @State private var isFlying = true
    /// Opacity of the flying layer. 1 for the whole open (it starts
    /// coincident with the tile); ramped up over `flyingRevealDuration` at
    /// the start of a close, where it is arriving on top of a sharper canvas.
    @State private var flyingReveal: CGFloat = 1
    /// Guards the open kick-off and the close commit against re-entry — a
    /// pinch release and a back tap can both land in the same frame.
    @State private var hasOpened = false
    @State private var isClosing = false

    /// Progress at which the editor starts fading in. Late enough that the
    /// chrome does not swim over the flying thumbnail for the whole flight.
    private static let editorFadeInStart: CGFloat = 0.45
    /// How long the flying thumbnail takes to arrive over the live canvas at
    /// the start of a close. Short — it is a softening, not a cross-fade.
    private static let flyingRevealDuration: Double = 0.1
    /// Fallback delay before opening without a reported canvas frame. The
    /// editor always reports one, so this only exists so a hypothetical
    /// layout stall cannot strand the user on an invisible overlay.
    private static let canvasFrameFallbackMilliseconds = 250

    var body: some View {
        ZStack {
            MapleTokens.bg
                .opacity(Double(progress))
                .ignoresSafeArea()

            EditorDestination(
                asset: asset,
                sessions: $sessions,
                heroZoom: EditorHeroZoom(
                    seedImage: source?.thumbnail,
                    onCanvasFrame: { canvasFrame = $0 },
                    onCloseProgress: pinchCloseChanged,
                    onCloseEnded: pinchCloseEnded
                ),
                onClose: close
            )
            .opacity(Double(editorOpacity))

            if let source, isFlying {
                HeroFlyingImage(
                    image: source.thumbnail,
                    rect: flyingRect(for: source),
                    cornerRadius: HeroZoomGeometry.interpolate(
                        from: source.cornerRadius,
                        to: 0,
                        progress: progress
                    )
                )
                .opacity(Double(flyingReveal))
            }
        }
        // Deliberately NOT `.ignoresSafeArea()` on the container: the editor
        // has to lay out against the same safe area a pushed destination
        // would, or its top pill slides under the status bar. The backdrop
        // ignores it on its own, and the flying layer is positioned from
        // global coordinates, so both still cover the full screen.
        .onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .global)
        } action: { frame in
            overlayFrame = frame
        }
        // Wait for the editor's real canvas geometry before animating: the
        // destination rect is derived from it, and starting early would make
        // the hero jump the moment the frame lands mid-flight. Until then the
        // flying thumbnail sits exactly over the tile it came from, so the
        // delay is invisible.
        .onChange(of: canvasFrame) { _, frame in
            guard frame.width > 0, frame.height > 0 else { return }
            open()
        }
        .task {
            try? await Task.sleep(for: .milliseconds(Self.canvasFrameFallbackMilliseconds))
            guard !Task.isCancelled else { return }
            open()
        }
        .accessibilityIdentifier("hero-zoom-editor")
    }

    // MARK: - Derived geometry

    /// The rect the hero flies into: the canvas's aspect-fit rect for this
    /// photo, in global coordinates. Falls back to the source tile before the
    /// canvas has reported its geometry, which keeps the hero parked on the
    /// tile rather than snapping to an arbitrary rect.
    private func destinationRect(for source: PhotoGridHeroSource) -> CGRect {
        guard canvasFrame.width > 0, canvasFrame.height > 0 else { return source.frame }
        let local = HeroZoomGeometry.fitRect(
            aspectRatio: source.aspectRatio,
            in: canvasFrame.size
        )
        return local.offsetBy(dx: canvasFrame.minX, dy: canvasFrame.minY)
    }

    /// Interpolated hero rect, converted from global into this overlay's own
    /// coordinate space (which `.position` measures against).
    private func flyingRect(for source: PhotoGridHeroSource) -> CGRect {
        let global = HeroZoomGeometry.interpolate(
            from: source.frame,
            to: destinationRect(for: source),
            progress: progress
        )
        return global.offsetBy(dx: -overlayFrame.minX, dy: -overlayFrame.minY)
    }

    private var editorOpacity: CGFloat {
        HeroZoomGeometry.delayedRamp(progress: progress, start: Self.editorFadeInStart)
    }

    // MARK: - Open

    private func open() {
        guard !hasOpened else { return }
        hasOpened = true
        withAnimation(MapleTokens.Motion.push) {
            progress = 1
        } completion: {
            // Only retire the flying layer if it is still the open flight —
            // a fast pinch-close can start before this completion runs.
            guard !isClosing else { return }
            isFlying = false
        }
    }

    // MARK: - Close

    /// Back button, edge swipe, or a committed pinch. Idempotent: whichever
    /// arrives first owns the close.
    private func close() {
        guard !isClosing else { return }
        isClosing = true
        beginFlying()
        withAnimation(MapleTokens.Motion.sheetDismiss) {
            progress = 0
        } completion: {
            onClosed()
        }
    }

    /// Live frame of an at-fit pinch-in. `CanvasZoomHost` only routes here
    /// once it has decided the gesture is a close, so there is no ambiguity
    /// left to resolve — drive the same progress the open animation drove,
    /// unanimated, so it tracks the fingers.
    private func pinchCloseChanged(_ closeProgress: CGFloat) {
        guard !isClosing else { return }
        beginFlying()
        progress = closeProgress
    }

    /// Pinch release: commit the close, or spring the hero back open.
    private func pinchCloseEnded(commit: Bool) {
        guard !isClosing else { return }
        if commit {
            close()
            return
        }
        withAnimation(MapleTokens.Motion.push) {
            progress = 1
        } completion: {
            guard !isClosing else { return }
            isFlying = false
        }
    }

    /// Re-mount the flying thumbnail for a close. It arrives on top of the
    /// live canvas, which is sharper than a grid thumbnail, so it fades in
    /// over a beat instead of popping.
    private func beginFlying() {
        guard !isFlying else { return }
        isFlying = true
        flyingReveal = 0
        withAnimation(.easeOut(duration: Self.flyingRevealDuration)) {
            flyingReveal = 1
        }
    }
}

#endif
