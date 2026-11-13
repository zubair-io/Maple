// CanvasZoomController.swift — observable zoom state + EditSession plumbing (#1099).
//
// Thin @Observable wrapper over the pure `CanvasZoomModel`: it owns the
// live zoom state for one canvas surface and forwards every committed
// change into the `EditSession` exactly the way the legacy
// `FullImageView` did —
//
//   • `previewSize` (real px) on viewport mount / resize, so the fast
//     phase renders at viewport resolution,
//   • the resolved `pixelScale` whenever it changes, so the refine pass
//     retargets (`nativeImageSize × min(pixelScale, 1)`),
//   • `updateTileVisibleRegion(viewport:zoom:)` on every commit —
//     zoom/pan gestures AND viewport resizes / native-size seeds — so
//     the deep-zoom tile manager always sees the live viewport.
//
// Gesture-live updates (pinch frames, drag frames) mutate only the
// model — the session is committed on gesture END, matching the legacy
// contract ("commit once on release so target-size refinements don't
// swap brightness mid-pinch"). Wheel-pan (trackpad two-finger scroll,
// #2036) follows the same "commit once" contract via a debounce —
// every event updates the model but the commit is deferred until the
// scroll stream goes idle, since a continuous scroll fires far too
// often to commit synchronously per event. Wheel-zoom, keyboard,
// toolbar, and double-tap remain genuinely discrete inputs and commit
// immediately.
//
// Lives in MapleCore so the editor (`EditorState`), the legacy full-image
// surface, and the S4 loupe (#577) share one implementation, and so the
// session plumbing is unit-testable next to the model.

import CoreGraphics
import Foundation

@MainActor
@Observable
public final class CanvasZoomController {
  /// The session this canvas renders. The controller's lifetime is
  /// bound to one session — hosts rebuild the controller when the
  /// asset/session changes (and `assetChanged()` guards view reuse).
  public let session: EditSession

  /// Live zoom state. Mutations go through the methods below so every
  /// state change lands in the session when it must.
  public internal(set) var model = CanvasZoomModel()

  /// Last viewport reported by the host, in points.
  public internal(set) var viewportPoints: CGSize = .zero
  /// Points → real-pixels factor reported by the host.
  public internal(set) var displayScale: CGFloat = 1
  /// Parts of the viewport the host's chrome covers. Fit, fill and the
  /// centred position resolve inside what is left.
  public internal(set) var viewportInsets: CanvasViewportInsets = .zero
  /// Whether the host has measured the chrome over the canvas, so the zoom
  /// resolves in the visible area the photo rests in. The host draws the
  /// photo only from then on: the chrome reports its frames a layout pass
  /// after the canvas measures its viewport, and a photo drawn before that
  /// would move once they land (#5769).
  public private(set) var isChromeMeasured: Bool
  /// The extent the canvas lays the photo out with until the real one is
  /// known (`setProvisionalImageSize`); `nil` once `nativeImageSizeChanged`
  /// carries the zoom into the real size. Layout keeps reading it until
  /// then: the host learns of the new size after its body has re-evaluated,
  /// and that frame must still draw the rect on screen (#5755).
  public internal(set) var provisionalImageSize: CGSize?

  /// The last commanded zoom (a menu or keyboard command, a double-tap,
  /// the badge, the wheel landing on fit) and the frame shown before it.
  /// The host animates from what is shown to the new resting frame (#5741).
  public private(set) var commandedMove: CanvasCommandedMove?

  /// What is drawn over the committed zoom: a live iOS pinch, a settle.
  /// The leaf and every overlay read it (`presentedGeometry(at:)`).
  public internal(set) var presentation = CanvasPresentation()

  /// Zoom held at fit (`lockZoomAtFit`): gestures and commands do nothing.
  public internal(set) var isZoomLocked = false

  /// The geometry the model was last carried into, so the next geometry
  /// change carries the zoom from it (`geometryChanged(from:to:)`).
  @ObservationIgnored var carriedContext: CanvasZoomContext?

  /// The live input of an iOS pinch, which freezes the committed frame and
  /// draws the live one itself (`gestureTransform`). Recorded into the model
  /// before any other transition so it continues from the frame on screen.
  @ObservationIgnored var trackedPinch: (magnification: CGFloat, location: CGPoint)?

  /// Whether zoom and viewport changes reach the session (its viewport
  /// size, pixel scale and visible region), and so start and steer its
  /// render. Preview holds them back until the photo is zoomed past its
  /// still's resolution, so opening and paging never decode (#5762).
  public internal(set) var rendersSession: Bool

  /// `chromeMeasured` is false for a canvas whose chrome reports its frames
  /// after the canvas measures its viewport (the editor).
  public init(session: EditSession, rendersSession: Bool = true, chromeMeasured: Bool = true) {
    self.session = session
    self.rendersSession = rendersSession
    self.isChromeMeasured = chromeMeasured
  }

  // MARK: - Derived geometry

  /// Geometry snapshot for the current viewport + session extent.
  ///
  /// Uses `session.effectiveImageSize` (#638) rather than the raw
  /// `nativeImageSize`: when a crop is applied (and the crop tool is not
  /// armed) the canvas, fit/100%/pan, and the visible-tile rect all key
  /// off the CROPPED extent so the cropped result fills the frame instead
  /// of being letterboxed inside the full-sensor rect. While the crop
  /// tool is armed `effectiveImageSize` resolves back to the full frame
  /// (the overlay sits over the uncropped image). A provisional extent, while
  /// one is held, takes precedence (`provisionalImageSize`).
  public var context: CanvasZoomContext {
    CanvasZoomContext(
      viewportPoints: viewportPoints,
      nativeImageSize: provisionalImageSize ?? realImageSize,
      displayScale: displayScale,
      insets: viewportInsets
    )
  }

  /// `pixelScale` with the `0 == fit` sentinel resolved.
  public var effectivePixelScale: CGFloat {
    context.effectiveScale(for: model.pixelScale)
  }

  /// Live pinch transform for the iOS host's compositor `.scaleEffect(anchor:
  /// .center)` + `.offset` (#1493): the scale factor relative to the frozen
  /// frame's scale (`pixelScale` does not move mid-pinch), and the live pan.
  /// Both come from the same `pinchChanged` transition the model runs, so the
  /// live visual is exactly the live model frame, and the release starts
  /// from it. Call only between the start `pinchChanged` (magnification 1)
  /// and `pinchEnded`. Published as `presentation.livePinch` for overlays.
  public func gestureTransform(
    magnification: CGFloat,
    liveCentroid: CGPoint
  ) -> (zoom: CGFloat, committedPan: CGSize) {
    // Require the start-capture frame (`pinchChanged` magnification 1) to
    // have run: without it the live pan would derive from a default start.
    let frozen = context.effectiveScale(for: model.pixelScale)
    guard !isZoomLocked, model.pinchStartScale != nil, frozen > 0 else {
      clearLivePinch()
      return (1, .zero)
    }
    trackedPinch = (magnification, liveCentroid)
    var live = model
    live.pinchChanged(magnification: magnification, location: liveCentroid, context: context)
    let shown = CanvasLivePinch(
      zoom: context.effectiveScale(for: live.pixelScale) / frozen, pan: live.panOffset)
    presentation.livePinch = shown
    return (shown.zoom, shown.pan)
  }

  /// The frame on screen at rest: the resolved scale and the pan.
  public var restingFrame: CanvasShownFrame {
    CanvasShownFrame(scale: effectivePixelScale, pan: model.panOffset)
  }

  /// On-screen image frame (points) at the current zoom. `nil` until
  /// the native size is seeded — consumers show their fallback.
  public var displayFrameInPoints: CGSize? {
    context.displayFrameInPoints(at: model.pixelScale)
  }

  /// Pan offset in points (positive = image dragged right/down).
  public var panOffset: CGSize { model.panOffset }

  /// True when the user has explicitly zoomed (not fit mode).
  public var isZoomedIn: Bool { model.isZoomedIn }

  /// Drag arbitration for the host (spec §5.0 table).
  public var dragIntent: CanvasZoomModel.DragIntent { model.dragIntent(context: context) }

  /// Wheel arbitration for the host (spec §5.0 table).
  public func wheelIntent(commandHeld: Bool) -> CanvasZoomModel.WheelIntent {
    model.wheelIntent(commandHeld: commandHeld, context: context)
  }

  // MARK: - View plumbing

  /// Host viewport mount / resize. Re-clamps the pan against the new
  /// geometry, pushes the real-pixel viewport into `previewSize`
  /// (fast-phase target), then commits the resolved scale AND the
  /// recomputed visible source rect — the visible rect depends on the
  /// viewport, so a resize that skipped the commit would leave
  /// deep-zoom consumers acting on a stale region (#1125 review).
  /// `chromeMeasured` is false while the chrome over the canvas has not
  /// reported its frames yet, so `insets` may still miss some of it.
  public func viewportChanged(
    points: CGSize, displayScale: CGFloat, insets: CanvasViewportInsets = .zero,
    chromeMeasured: Bool = true
  ) {
    guard points.width > 0, points.height > 0 else { return }
    self.viewportPoints = points
    self.displayScale = displayScale
    self.viewportInsets = insets
    if chromeMeasured { isChromeMeasured = true }
    carryIntoCurrentGeometry()
    pushViewportToSession()
    commitToSession()
  }

  /// The chrome covering the canvas changed (a bar shown or hidden, the
  /// inspector resized), or reported its frames for the first time. A zoomed
  /// image keeps its place unless the new visible area leaves it outside the
  /// resting range; at fit it re-fits in the new visible area.
  ///
  /// Returns whether a photo already on screen moved, so the host animates
  /// from what it showed. Insets that complete the canvas's first
  /// measurement return false: nothing was drawn before them.
  @discardableResult
  public func viewportInsetsChanged(
    _ insets: CanvasViewportInsets, chromeMeasured: Bool = true
  ) -> Bool {
    let wasOnScreen = isChromeMeasured
    if chromeMeasured { isChromeMeasured = true }
    guard insets != viewportInsets else { return false }
    viewportInsets = insets
    guard viewportPoints != .zero else { return false }
    carryIntoCurrentGeometry()
    commitToSession()
    return wasOnScreen
  }

  /// Hold the frame the host is showing mid-animation as the resting state,
  /// so a pinch or pan that interrupts a settle starts from what is on
  /// screen rather than from where the settle was heading (#5742).
  public func holdShownFrame(_ frame: CanvasShownFrame) {
    guard !isZoomLocked else { return }
    recordTrackedPinch()
    let before = model
    model.holdShown(frame, context: context)
    guard model != before else { return }
    commitToSession()
  }

  /// Lay the photo out with `size` — a stand-in with the seed thumbnail's
  /// aspect at a nominal size — until the session's real extent is known,
  /// so gestures on the placeholder act on a real layout. When the real
  /// size lands, `nativeImageSizeChanged` keeps the photo's rect on screen
  /// exactly and only the pixels change (#5736). Ignored once the real size
  /// is known; `nil` clears it. The seed placeholder feeds it in #5755.
  public func setProvisionalImageSize(_ size: CGSize?) {
    guard realImageSize == .zero else { return }
    let usable = size.flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil }
    guard usable != provisionalImageSize else { return }
    provisionalImageSize = usable
    guard viewportPoints != .zero else { return }
    carryIntoCurrentGeometry()
  }

  /// The session's extent changed: the real `nativeImageSize` landed or a
  /// crop was applied or cleared (#638). Re-resolves fit so the idle refine
  /// targets viewport resolution, and re-pushes the visible rect, which
  /// depends on the extent (#1125 review). Replacing a provisional extent
  /// keeps the photo's rect on screen; a crop keeps the pixel scale.
  ///
  /// Returns the factor that maps a scale drawn in the previous extent into
  /// the new one, for an animation the host is running (1 for a crop).
  @discardableResult
  public func nativeImageSizeChanged() -> CGFloat {
    let previous = carriedContext
    let resolvesProvisional = provisionalImageSize != nil && realImageSize != .zero
    if resolvesProvisional { provisionalImageSize = nil }
    guard viewportPoints != .zero else { return 1 }
    carryIntoCurrentGeometry(resolvingProvisional: resolvesProvisional)
    pushViewportToSession()
    commitToSession()
    guard resolvesProvisional, let old = previous?.nativeImageSize.width, old > 0 else {
      return 1
    }
    return old / context.nativeImageSize.width
  }

  var realImageSize: CGSize { session.effectiveImageSize }

  /// The host's asset switched under a reused view — reset to fit so a
  /// stale zoom doesn't make the new image's refine pass target the
  /// full native extent.
  public func assetChanged() {
    trackedPinch = nil
    provisionalImageSize = nil
    presentation = CanvasPresentation()
    model.pinchCancelled(context: context)
    model.dragCancelled()
    model.resetToFit(context: context)
    carriedContext = context
    guard viewportPoints != .zero else { return }
    pushViewportToSession()
    commitToSession()
  }

  // MARK: - Gestures

  /// Pinch frame (cumulative `magnification` since gesture start,
  /// anchor in viewport points). Model-only — committed on end.
  public func pinchChanged(magnification: CGFloat, location: CGPoint) {
    guard !isZoomLocked else { return }
    model.pinchChanged(magnification: magnification, location: location, context: context)
  }

  /// The fingers of a live pinch changed: re-anchor so the next frame with
  /// `magnification` at `location` reproduces the frame shown at
  /// `shownMagnification` about `shownLocation` (#5732). Model-only, like
  /// `pinchChanged`.
  public func pinchRebased(
    shownMagnification: CGFloat, shownLocation: CGPoint,
    magnification: CGFloat, location: CGPoint
  ) {
    guard !isZoomLocked else { return }
    trackedPinch = (magnification, location)
    model.pinchRebased(
      shownMagnification: shownMagnification, shownLocation: shownLocation,
      magnification: magnification, location: location, context: context)
  }

  /// Pinch release — commits the resolved scale + visible rect.
  public func pinchEnded(magnification: CGFloat) {
    trackedPinch = nil
    clearLivePinch()
    guard !isZoomLocked else { return }
    model.pinchEnded(magnification: magnification, context: context)
    commitToSession()
  }

  /// Drag frame. No-op at fit (the drag belongs to the editing
  /// surface); pans when zoomed. Model-only — committed on end.
  public func dragChanged(translation: CGSize) {
    recordTrackedPinch()
    model.dragChanged(translation: translation, context: context)
  }

  /// A new drag gesture began. Commits what the previous drag left on
  /// screen, so a drag whose end SwiftUI never delivered (a cancelled
  /// gesture) cannot make this one jump back (#5739).
  public func dragBegan() {
    model.dragBegan()
  }

  /// The pinch was cancelled: it ends at its last frame and settles as its
  /// release would; the host animates that move.
  public func pinchCancelled() {
    recordTrackedPinch()
    trackedPinch = nil
    clearLivePinch()
    let before = model
    model.pinchCancelled(context: context)
    guard model != before else { return }
    commitToSession()
  }

  /// The drag was cancelled: it commits where it is and, outside a pinch,
  /// settles into the resting range as its release would. A live pinch is
  /// not the drag's and stays live.
  public func dragCancelled() {
    let before = model
    model.dragCancelled()
    if model.pinchStartScale == nil { model.reclampPan(context: context) }
    guard model != before else { return }
    commitToSession()
  }

  /// Drag release — pushes the new visible rect when a pan committed. A
  /// drag that began from a held, out-of-range frame settles into range
  /// here; the host animates that move.
  public func dragEnded() {
    guard model.dragEnded() else { return }
    model.reclampPan(context: context)
    commitToSession()
  }

  /// Absorb a drag's running translation into the baseline without panning —
  /// used by the host during the post-pinch cooldown so the lingering finger
  /// can't pan, yet a deliberate pan that continues past the cooldown resumes
  /// smoothly (#1509).
  public func rebaseDrag(translation: CGSize) {
    model.rebaseDragBaseline(translation)
  }

  /// Double-tap / double-click per the configured behavior.
  public func doubleTap(at location: CGPoint, behavior: CanvasZoomModel.DoubleTapBehavior) {
    command { $0.doubleTap(at: location, behavior: behavior, context: context) }
  }

  /// Two-finger scroll / wheel pan while zoomed (deltas in points).
  /// Model-only per event — the debounced commit below coalesces the
  /// stream, matching the drag/pinch "commit once" contract (#2036).
  /// Trackpad two-finger scroll emits dozens of events/sec; a
  /// synchronous per-event commit reaches `updateTileVisibleRegion`,
  /// which clears the native-detail overlay (visible sharp→blurry
  /// flicker for the whole pan) and reschedules a refine Task on every
  /// event.
  public func wheelPan(delta: CGSize) {
    guard model.isZoomedIn, !isZoomLocked else { return }
    recordTrackedPinch()
    model.wheelPan(by: delta, context: context)
    scheduleWheelPanCommit()
  }

  /// Cmd+scroll zoom anchored at the cursor (normalized delta —
  /// positive zooms in).
  /// Landing on fit from a zoom is a snap, so it animates; every other wheel
  /// zoom follows the wheel directly.
  public func wheelZoom(normalizedDeltaY: CGFloat, location: CGPoint) {
    guard !isZoomLocked else { return }
    recordTrackedPinch()
    let shown = restingFrame
    let wasZoomed = model.isZoomedIn
    model.wheelZoom(normalizedDeltaY: normalizedDeltaY, location: location, context: context)
    if wasZoomed, !model.isZoomedIn { recordCommandedMove(from: shown) }
    commitToSession()
  }

  // MARK: - Continuity

  /// A deliberate zoom: apply it, record the frame shown before so the host
  /// animates the move, and commit. A live gesture continues from the result.
  func command(_ transition: (inout CanvasZoomModel) -> Void) {
    guard !isZoomLocked else { return }
    recordTrackedPinch()
    let shown = restingFrame
    if let tracked = trackedPinch, model.pinchStartScale != nil {
      // The iOS host shows the live pinch over a frozen frame: the command
      // starts from the live frame, as on a host that draws it committed.
      model.pinchChanged(
        magnification: tracked.magnification, location: tracked.location, context: context)
    }
    transition(&model)
    recordCommandedMove(from: shown)
    commitToSession()
  }

  private func recordCommandedMove(from shown: CanvasShownFrame) {
    guard restingFrame != shown else { return }
    commandedMove = CanvasCommandedMove(from: shown, serial: (commandedMove?.serial ?? 0) + 1)
  }

  /// Carry the zoom from the geometry it was last resolved against into the
  /// current one; the first geometry only re-resolves.
  func carryIntoCurrentGeometry(resolvingProvisional: Bool = false) {
    recordTrackedPinch()
    let next = context
    if let previous = carriedContext, resolvingProvisional {
      model.imageExtentResolved(from: previous, to: next)
    } else if let previous = carriedContext {
      model.geometryChanged(from: previous, to: next)
    } else {
      model.reclampPan(context: next)
    }
    carriedContext = next
  }

  func recordTrackedPinch() {
    guard let tracked = trackedPinch, model.pinchStartScale != nil else { return }
    model.pinchTracked(magnification: tracked.magnification, location: tracked.location)
  }

  // MARK: - Wheel-pan commit debounce (#2036)

  /// Wheel-pan commit debounce — a continuous trackpad two-finger
  /// scroll fires dozens of events per second; committing per event
  /// (the previous behaviour) forced a native-detail clear + refine
  /// reschedule on every one. 120 ms comfortably exceeds the gap
  /// between consecutive scroll-wheel events (including a momentum
  /// tail) while still committing promptly once the pan actually
  /// stops.
  public static let wheelPanCommitDebounceMilliseconds: UInt64 = 120

  /// Interval `scheduleWheelPanCommit` actually sleeps. A stored
  /// (not static) value so `_testSetWheelPanCommitInterval` can shrink
  /// it for a fast coalescing test; production never touches this.
  private var wheelPanCommitIntervalMilliseconds: UInt64 =
    CanvasZoomController.wheelPanCommitDebounceMilliseconds

  /// Pending debounced commit — cancelled and replaced on every
  /// `wheelPan` event so only the tail of a continuous scroll (momentum
  /// included, since momentum just extends the event stream) survives
  /// to actually commit. Same cancel-previous-task idiom as
  /// `RenderActor.refineTask`.
  private var wheelPanCommitTask: Task<Void, Never>?

  /// (Re)arms the debounced wheel-pan commit. Cancelling the previous
  /// pending Task on every call means a steady stream of events keeps
  /// pushing the commit out; it only fires once the stream goes idle
  /// for `wheelPanCommitIntervalMilliseconds`.
  private func scheduleWheelPanCommit() {
    wheelPanCommitTask?.cancel()
    let intervalMilliseconds = wheelPanCommitIntervalMilliseconds
    wheelPanCommitTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(Int(intervalMilliseconds)))
      guard !Task.isCancelled else { return }
      self?._testWheelPanCommitFireCount += 1
      self?.commitToSession()
    }
  }

  // MARK: - Test hooks

  /// Shrinks the wheel-pan commit debounce so a coalescing test doesn't
  /// have to sleep the production 120 ms per assertion.
  internal func _testSetWheelPanCommitInterval(milliseconds: UInt64) {
    wheelPanCommitIntervalMilliseconds = milliseconds
  }

  /// Number of times the debounced wheel-pan commit has actually fired
  /// (i.e. survived to the end of its sleep uncancelled). `Task.isCancelled`
  /// stays `false` after a task simply completes, so it can't distinguish
  /// "pending" from "already fired" — this counter is the reliable signal
  /// a coalescing test needs.
  internal private(set) var _testWheelPanCommitFireCount = 0

  /// Captures the scheduled task so tests can observe cancellation and await
  /// completion without assuming when a loaded runner resumes a fixed sleep.
  internal var _testPendingWheelPanCommitTask: Task<Void, Never>? {
    wheelPanCommitTask
  }

  // MARK: - Session commit

  /// Push the resolved zoom + visible source rect into the session.
  /// `updateTileVisibleRegion` owns both the `pixelScale` write (its
  /// `didSet` reschedules the refine) and the pure-pan refine kick, so
  /// one call covers every commit path — same contract the legacy
  /// `FullImageView.notifyVisibleRegion()` had.
  ///
  /// No-ops until the host has reported a real viewport: against a
  /// degenerate viewport `CanvasMath` resolves fit to 1, so an early
  /// commit (toolbar shortcut firing before the first
  /// `viewportChanged`) would write a wrong `session.pixelScale` and
  /// schedule refines against the wrong target (#1125 review). The
  /// model already holds the user's intent, so the skipped commit
  /// flushes naturally on the next `viewportChanged` — which always
  /// commits.
  func commitToSession() {
    // Any commit supersedes a pending debounced wheel-pan commit — both
    // would push the same current model state, so letting the debounce
    // fire later would only re-trigger `updateTileVisibleRegion` for
    // nothing (PR #2047 review).
    wheelPanCommitTask?.cancel()
    wheelPanCommitTask = nil
    guard rendersSession, viewportPoints.width > 0, viewportPoints.height > 0 else { return }
    // Same rule for the image extent: before the metadata seed lands,
    // `CanvasMath` resolves fit to 1, so a commit here would write a
    // literal 100% into `session.pixelScale` — sizing the seed thumbnail
    // and the CPU backdrop at full native and arming native-detail for an
    // image that should open at fit (#3540). The seed's
    // `nativeImageSizeChanged` commits the real fit the moment it lands.
    // A provisional extent is a layout stand-in, never a source region.
    guard provisionalImageSize == nil, realImageSize != .zero else { return }
    let math = context.canvasMath(
      pixelScale: model.pixelScale,
      panOffset: model.panOffset
    )
    session.updateTileVisibleRegion(
      viewport: math.visibleSourceRect,
      zoom: math.effectivePixelScale
    )
  }
}
