// CanvasZoomHost.swift — reusable zoom/pan/gesture canvas host (#1099).
//
// The shared canvas capability extracted from the legacy `FullImageView`
// (spec §5.0): pixelScale zoom (0 = fit … 8.0 cap), clamped pan, pinch
// via `MagnifyGesture` with a start-captured scale, double-tap, Cmd+
// scroll-wheel zoom, wheel pan, and the always-visible zoom badge. Both
// the legacy full-image surface and the S5 `EditorView` embed this host;
// the S4 loupe adopts it under #577.
//
// The host owns the viewport: it reports the live size into the
// `CanvasZoomController` (which pushes `previewSize` / `pixelScale` /
// the visible tile rect into the `EditSession`), frames the consumer's
// canvas leaf at the resolved display frame, and clips overflow so a
// zoomed-in canvas pans inside a fixed window.
//
// Gesture arbitration (spec §5.0 — the editor's editing gestures keep
// working):
//
//   • Pinch                → zoom, anchored at the gesture location.
//   • Drag                 → pan when zoomed; INERT at fit (the drag
//                            belongs to the editing surface / system
//                            gestures — attached via simultaneousGesture
//                            so nothing else is starved).
//   • Plain wheel (macOS)  → pan when zoomed; at fit it routes to
//                            `onWheelEditing` (armed-tool nudge in the
//                            editor) or passes through when nil (legacy).
//   • Cmd+wheel (macOS)    → zoom anchored at the cursor.
//   • Double-tap / click   → per `doubleTapBehavior` (legacy: reset to
//                            fit; editor: toggle fit ↔ 100%).
//
// Keyboard shortcuts stay with the consumers (legacy toolbar ⌘0/⌘1/⌘=/⌘-,
// editor toolbar ⌘0/⌘1) — they call the controller's command methods.

import SwiftUI
import MapleCore
#if os(iOS)
import UIKit

/// How long after a pinch release to ignore drag-pans — the second-finger
/// lift-off window, during which the lingering finger would otherwise fire a
/// one-finger pan that jumps the just-committed canvas (#1509).
private let postPinchPanCooldown: TimeInterval = 0.3
#endif

struct CanvasZoomHost<CanvasLeaf: View, Fallback: View>: View {
    /// Zoom state + EditSession plumbing. Owned by the consumer so
    /// toolbar / keyboard commands can drive the same state.
    let controller: CanvasZoomController
    /// Double-tap routing — `.resetToFit` (legacy) or
    /// `.toggleFitAnd100` (editor, spec §5.0).
    var doubleTapBehavior: CanvasZoomModel.DoubleTapBehavior = .resetToFit
    /// At-fit plain-wheel hook (macOS): the editor routes detents into
    /// the armed tool (steps, unit-per-step). `nil` (legacy) lets the
    /// event pass through unhandled.
    var onWheelEditing: ((Int, Double) -> Void)? = nil
    /// True when the consumer has pixels to show — the leaf renders
    /// framed + gestured; otherwise the fallback shows.
    let canvasReady: Bool
    /// The canvas leaf (CIImage raster / GPU layer). The host frames it
    /// to the resolved display frame; the leaf fills that proposal.
    @ViewBuilder let canvasLeaf: () -> CanvasLeaf
    /// Shown while no frame can resolve (no preview yet / no native
    /// size). Receives the viewport's full size.
    @ViewBuilder let fallback: () -> Fallback

    @Environment(\.displayScale) private var displayScale
    #if os(macOS)
    @State private var nudgeAccumulator = CanvasWheelNudgeAccumulator()
    #endif
    #if os(iOS)
    // Live pinch is rendered as a compositor `.scaleEffect` about the viewport
    // CENTRE — `pixelScale` is left untouched until release, so the frame never
    // grows mid-gesture and the canvas never re-decodes per frame (#1493). The
    // focal-anchoring lives entirely in `gestureCommittedPan` (the would-be
    // committed pan), so the live visual equals the committed geometry exactly.
    // At rest `gestureZoom == 1`, so the modifier chain is inert.
    @State private var gestureZoom: CGFloat = 1
    @State private var gestureCommittedPan: CGSize = .zero
    @State private var pinchActive = false
    @State private var pinchLastCentroid: CGPoint = .zero
    // Magnification of the LAST rendered frame. The commit uses this (not the
    // gesture-end recognizer scale, which differs as the fingers lift) so the
    // committed scale/pan exactly matches the last frame shown — no snap.
    @State private var pinchLastMag: CGFloat = 1
    // Live effective scale shown in the zoom badge during a pinch. `pixelScale`
    // is frozen mid-gesture (the zoom is a compositor transform), so the badge
    // would otherwise read the pre-pinch value — drive it from the live factor.
    // nil → not pinching → badge reads the committed `effectivePixelScale`.
    @State private var liveZoomScale: CGFloat?
    // When a pinch was released. Two fingers never lift in the same instant, so the
    // lingering finger fires a one-finger drag the moment the pinch ends —
    // which would pan/jump the just-committed canvas. We ignore drag-pans for a
    // short window after release (absorbing the movement into the baseline so a
    // deliberate continued pan resumes smoothly). Time-based → self-clearing.
    @State private var lastPinchEnd: Date?
    #endif

    var body: some View {
        GeometryReader { geo in
            ZStack {
                if canvasReady, let frame = controller.displayFrameInPoints {
                    canvasLeaf()
                        .frame(width: frame.width, height: frame.height)
                        #if os(iOS)
                        // Live pinch: scale the frozen frame about its centre in
                        // the compositor (cheap, no re-decode), positioned by the
                        // would-be committed pan (which carries the focal anchor).
                        // `.scaleEffect(1)` is identity at rest. On release the
                        // frame grows to `frame×zoom` with `panOffset ==
                        // gestureCommittedPan`, which is geometrically identical —
                        // no jump.
                        .scaleEffect(gestureZoom, anchor: .center)
                        .offset(pinchActive ? gestureCommittedPan : controller.panOffset)
                        #else
                        .offset(controller.panOffset)
                        #endif
                } else {
                    fallback()
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .clipped()
            .contentShape(Rectangle())
            #if os(iOS)
            // UIKit pinch — its `location(in:)` reports the exact two-finger
            // centroid (the focal point), which SwiftUI's `MagnifyGesture` did
            // not anchor on dependably. During the gesture we DON'T grow the
            // frame (that re-decodes every frame, the lag); instead we scale the
            // committed frame in the compositor and commit `pixelScale` once on
            // release — see `pinchChangedLive` / `pinchEndedLive`.
            .gesture(
                CanvasPinchGesture(
                    onChanged: { scale, location in
                        pinchChangedLive(scale: scale, location: location)
                    },
                    onEnded: { scale in
                        pinchEndedLive(scale: scale)
                    }
                )
            )
            #else
            .gesture(magnifyGesture(viewport: geo.size))
            #endif
            .simultaneousGesture(dragGesture)
            .onTapGesture(count: 2) { location in
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    controller.doubleTap(at: location, behavior: doubleTapBehavior)
                }
            }
            .background(wheelCatcher)
            .overlay(alignment: .bottomLeading) { zoomBadge }
            .onAppear {
                controller.viewportChanged(points: geo.size, displayScale: displayScale)
            }
            .onChange(of: geo.size) { _, newSize in
                controller.viewportChanged(points: newSize, displayScale: displayScale)
            }
            .onChange(of: displayScale) { _, newScale in
                // Window dragged to a display with a different backing
                // scale — same points, different real pixels. Re-resolve
                // so 100% stays pixel-perfect on the new screen.
                controller.viewportChanged(points: geo.size, displayScale: newScale)
            }
            .onChange(of: controller.session.effectiveImageSize) { _, _ in
                // Pre-decode, fit mode guesses; recompute once the real
                // size lands so the idle refine stays at viewport
                // resolution (legacy FullImageView did the same).
                //
                // #638: keyed on `effectiveImageSize` (not raw
                // `nativeImageSize`) so applying / changing / clearing a
                // crop — which changes the displayed extent without touching
                // the sensor dims — re-resolves fit and re-frames the canvas
                // onto the cropped image.
                controller.nativeImageSizeChanged()
            }
            .onChange(of: controller.session.asset.id) { _, _ in
                // Asset switched under a reused view — reset to fit so a
                // stale pixelScale doesn't retarget the new image's
                // refine at full native.
                controller.assetChanged()
            }
        }
    }

    // MARK: - Gestures

    #if os(macOS)
    private func magnifyGesture(viewport: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                // The controller captures the start scale/pan/anchor on
                // the first frame — `magnification` is cumulative, so
                // anchoring against the live scale would compound.
                let anchor = CGPoint(
                    x: value.startAnchor.x * viewport.width,
                    y: value.startAnchor.y * viewport.height
                )
                controller.pinchChanged(
                    magnification: value.magnification,
                    location: anchor
                )
            }
            .onEnded { value in
                controller.pinchEnded(magnification: value.magnification)
            }
    }
    #endif

    #if os(iOS)
    /// Live pinch frame: track the focal and scale the committed frame in the
    /// compositor. On the first frame we capture the gesture's start state in
    /// the model (magnification 1 → no change) so the release commit anchors at
    /// this focal + the start scale/pan; subsequent frames only update the cheap
    /// `.scaleEffect` (no `pixelScale` write → no frame growth → no per-frame
    /// re-decode, which was the lag).
    private func pinchChangedLive(scale: CGFloat, location: CGPoint) {
        if !pinchActive {
            pinchActive = true
            // Capture the start state in the model (magnification 1 → no change)
            // so the release commit + the live `gestureTransform` both anchor at
            // this focal + the start scale/pan.
            controller.pinchChanged(magnification: 1.0, location: location)
        }
        pinchLastCentroid = location
        pinchLastMag = scale
        // The would-be committed scale + pan, clamped to the same legal region
        // the release will use. The pan carries the focal anchor, so scaling the
        // frozen frame about its centre and offsetting by this pan reproduces the
        // committed geometry exactly — the live visual == the commit, no jump.
        let transform = controller.gestureTransform(magnification: scale, liveCentroid: location)
        gestureZoom = transform.zoom
        gestureCommittedPan = transform.committedPan
        // `effectivePixelScale` is frozen at the start scale mid-gesture, so
        // `start × zoom` == the live (would-be-committed) scale for the badge.
        liveZoomScale = controller.effectivePixelScale * transform.zoom
    }

    /// Pinch release: commit the final scale + focal-anchored pan to the model
    /// (one re-render at the new size) and reset the compositor transform.
    /// Because the committed frame at the new scale is geometrically identical
    /// to the old frame under `.scaleEffect(gestureZoom)`, clearing the
    /// transform in the same update is pop-free — the canvas just sharpens as
    /// the re-render lands.
    private func pinchEndedLive(scale: CGFloat) {
        guard pinchActive else {
            controller.pinchEnded(magnification: scale)
            return
        }
        // Commit the LAST displayed frame's magnification + centroid (not the
        // gesture-end scale, which drifts as the fingers lift) so the committed
        // scale/pan equals what was on screen — the transform reset is pop-free.
        controller.pinchChanged(magnification: pinchLastMag, location: pinchLastCentroid)
        controller.pinchEnded(magnification: pinchLastMag)
        resetPinchState()
        lastPinchEnd = Date()   // open the cooldown for the lingering finger
    }

    /// Clear the per-gesture pinch bookkeeping so a release can't leave state
    /// set for the next pinch.
    private func resetPinchState() {
        pinchActive = false
        gestureZoom = 1
        gestureCommittedPan = .zero
        pinchLastMag = 1
        liveZoomScale = nil
    }
    #endif

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { value in
                #if os(iOS)
                // Within the post-pinch cooldown this is the lingering finger
                // from the lift, not a deliberate pan — absorb it into the
                // baseline (so a pan that continues past the window resumes with
                // no jump) and don't move the canvas.
                if let end = lastPinchEnd {
                    if Date().timeIntervalSince(end) < postPinchPanCooldown {
                        controller.rebaseDrag(translation: value.translation)
                        return
                    }
                    lastPinchEnd = nil   // window elapsed — resume normal panning
                }
                #endif
                // Pans only when zoomed in; a no-op at fit so the
                // editing surface (armed-tool scrub on DragBar, system
                // edge-swipe) keeps full ownership of fit-mode drags.
                controller.dragChanged(translation: value.translation)
            }
            .onEnded { _ in
                #if os(iOS)
                lastPinchEnd = nil
                #endif
                controller.dragEnded()
            }
    }

    // MARK: - Scroll wheel (macOS)

    /// Transparent wheel-event catcher behind the canvas. Compiles to
    /// nothing off macOS (no scroll wheel there; pinch covers zoom).
    @ViewBuilder
    private var wheelCatcher: some View {
        #if os(macOS)
        ScrollWheelCatcher { event in
            handleWheel(event)
        }
        #else
        Color.clear
        #endif
    }

    #if os(macOS)
    /// Wheel routing per the spec §5.0 table. Returns true when the
    /// event was consumed.
    private func handleWheel(_ event: ScrollWheelCatcher.WheelEvent) -> Bool {
        switch controller.wheelIntent(commandHeld: event.commandHeld) {
        case .zoom:
            // Momentum tails from a previous flick shouldn't keep
            // zooming once Cmd goes down mid-coast.
            guard !event.isMomentum else { return true }
            let normalized = event.precise ? event.deltaY : event.deltaY * 8
            guard normalized != 0 else { return true }
            controller.wheelZoom(normalizedDeltaY: normalized, location: event.location)
            return true
        case .pan:
            let factor: CGFloat = event.precise ? 1 : 8
            controller.wheelPan(
                delta: CGSize(width: event.deltaX * factor, height: event.deltaY * factor)
            )
            return true
        case .editing:
            // At fit the wheel belongs to the editing surface: the
            // editor nudges the armed tool ±1 per detent (±10 shift,
            // ±0.1 option — S5 desktop contract). Consumers without a
            // handler (legacy full image) pass the event through.
            guard let onWheelEditing else { return false }
            guard !event.isMomentum else { return true }
            let steps = nudgeAccumulator.steps(deltaY: event.deltaY, precise: event.precise)
            guard steps != 0 else { return true }
            let unit: Double = event.shiftHeld ? 10 : (event.optionHeld ? 0.1 : 1)
            onWheelEditing(steps, unit)
            return true
        }
    }
    #endif

    // MARK: - Zoom badge

    /// Always-visible zoom percentage (docs/zoom.md § Zoom Indicator),
    /// pinned to the viewport's bottom-leading corner — the `.clipped()`
    /// container above keeps it anchored to the visible canvas, not the
    /// potentially-huge image frame.
    private var zoomBadge: some View {
        #if os(iOS)
        // During an iOS pinch `pixelScale` is frozen (the zoom is a compositor
        // transform), so read the live factor; macOS updates pixelScale live.
        let scale = liveZoomScale ?? controller.effectivePixelScale
        #else
        let scale = controller.effectivePixelScale
        #endif
        return Text(FullImageViewVM.zoomPercentLabel(for: scale))
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 4))
            .padding(8)
            .accessibilityLabel(FullImageViewVM.zoomAccessibilityLabel(for: scale))
            .accessibilityIdentifier("canvas-zoom-indicator")
    }
}

// MARK: - CanvasPinchGesture (iOS)

#if os(iOS)
/// Bridges a UIKit `UIPinchGestureRecognizer` into SwiftUI so the canvas
/// zoom can anchor at the EXACT two-finger centroid. `recognizer.scale` is
/// the cumulative magnification since the gesture began (matching what the
/// `CanvasZoomController` expects); `recognizer.location(in:)` is the centroid
/// in the gesture view's local space — the reliable focal point SwiftUI's
/// `MagnifyGesture` (startAnchor / startLocation) failed to provide.
private struct CanvasPinchGesture: UIGestureRecognizerRepresentable {
    let onChanged: (CGFloat, CGPoint) -> Void
    let onEnded: (CGFloat) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPinchGestureRecognizer {
        UIPinchGestureRecognizer()
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPinchGestureRecognizer, context: Context) {
        // `context.converter.localLocation` is the centroid in the SwiftUI
        // view's LOCAL space (the viewport) — the space the zoom math uses.
        // `recognizer.location(in: recognizer.view)` is measured against a
        // larger hosting view whose origin sits above the viewport, so it read
        // `y` too large and the focal point landed below the fingers.
        let centroid = context.converter.localLocation
        switch recognizer.state {
        case .began, .changed:
            onChanged(recognizer.scale, centroid)
        case .ended, .cancelled, .failed:
            onEnded(recognizer.scale)
        default:
            break
        }
    }
}
#endif

// MARK: - ScrollWheelCatcher (macOS)

#if os(macOS)
/// Invisible NSView that observes scroll-wheel events over its own
/// frame via a local event monitor. `hitTest` returns nil so clicks and
/// drags pass straight through to the SwiftUI gestures above it; the
/// monitor sees every scroll event first and only intercepts those whose
/// cursor location falls inside this view's bounds in the key window.
struct ScrollWheelCatcher: NSViewRepresentable {
    struct WheelEvent {
        let deltaX: CGFloat
        let deltaY: CGFloat
        /// True for trackpads (continuous point deltas); false for
        /// line-based mouse wheels.
        let precise: Bool
        /// Cursor location in this view's (flipped, top-left-origin)
        /// coordinates — matches SwiftUI's local space.
        let location: CGPoint
        let commandHeld: Bool
        let shiftHeld: Bool
        let optionHeld: Bool
        /// True during inertial-scroll momentum tails.
        let isMomentum: Bool
    }

    /// Return true to consume the event (it never reaches AppKit),
    /// false to pass it through unchanged.
    let onWheel: @MainActor (WheelEvent) -> Bool

    func makeNSView(context: Context) -> CatcherView {
        let view = CatcherView()
        view.onWheel = onWheel
        return view
    }

    func updateNSView(_ nsView: CatcherView, context: Context) {
        nsView.onWheel = onWheel
    }

    final class CatcherView: NSView {
        var onWheel: (@MainActor (WheelEvent) -> Bool)?
        private var monitor: Any?

        /// Top-left-origin local coordinates, matching SwiftUI.
        override var isFlipped: Bool { true }

        /// Never participate in hit-testing — clicks, drags and pinches
        /// belong to the SwiftUI layer; this view only watches the
        /// event monitor.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window != nil {
                installMonitorIfNeeded()
            } else {
                removeMonitorIfNeeded()
            }
        }

        deinit {
            if let monitor {
                NSEvent.removeMonitor(monitor)
            }
        }

        private func installMonitorIfNeeded() {
            guard monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel]) { [weak self] event in
                guard let self,
                      let handler = self.onWheel,
                      let window = self.window,
                      event.window === window
                else { return event }
                let local = self.convert(event.locationInWindow, from: nil)
                guard self.bounds.contains(local) else { return event }
                let wheel = WheelEvent(
                    deltaX: event.scrollingDeltaX,
                    deltaY: event.scrollingDeltaY,
                    precise: event.hasPreciseScrollingDeltas,
                    location: local,
                    commandHeld: event.modifierFlags.contains(.command),
                    shiftHeld: event.modifierFlags.contains(.shift),
                    optionHeld: event.modifierFlags.contains(.option),
                    isMomentum: event.momentumPhase != []
                )
                // Local monitors fire on the main thread; the handler
                // touches MainActor state (controller / EditorState).
                let consumed = MainActor.assumeIsolated { handler(wheel) }
                return consumed ? nil : event
            }
        }

        private func removeMonitorIfNeeded() {
            if let monitor {
                NSEvent.removeMonitor(monitor)
                self.monitor = nil
            }
        }
    }
}
#endif
