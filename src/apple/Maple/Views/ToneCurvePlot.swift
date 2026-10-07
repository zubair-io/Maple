// ToneCurvePlot.swift — the square point-curve canvas (#367).
//
// Drawn with `Canvas` (grid, identity diagonal, the curve itself) and an
// overlaid stack of real `Circle` views for the control points. The split is
// deliberate: `Canvas` repaints the curve cheaply on every drag sample, but a
// shape drawn INSIDE it is invisible to VoiceOver, and the curve editor is the
// one control in the editor where "the third point from the left" is the only
// way to say what you are grabbing. There are never more than a handful of
// knots, so hoisting them out as views costs nothing and buys each one a real
// accessibility label plus keyboard focus.
//
// The view is purely presentational: it takes a point list and hands edited
// lists back through `onChange` / `onEditingChanged`. Every editing RULE — endpoint
// pinning, the neighbour gap, identity collapse — lives in
// `ToneCurveEditing` in MapleCore, so the SwiftUI and Angular widgets
// enforce the same invariants and both are unit-tested without a UI host.
//
// ## Render-tick budget
//
// `onChange` writes `session.model`, which re-runs the live wgpu chain. That
// is affordable at pointer rate ONLY because `RawCoreBridge.stripAppleGPUStages`
// strips the four `toneCurve*` fields (#367), so a curve edit leaves the
// decode-cache key untouched and never triggers a re-decode. It is still not
// free, so the session scheduler keeps one active render and the latest
// requested value. A second wall-clock gate here could skip alternate 60Hz
// events; the plot paints locally and forwards every changed value.

import MapleCore
import SwiftUI

struct ToneCurvePlot: View {
  /// The committed point list for the active channel (empty = identity).
  let readPoints: () -> [ToneCurvePoint]

  // Focused keyboard handlers can outlive a body update; read the current authored curve.
  private var points: [ToneCurvePoint] { readPoints() }
  /// Stroke colour for this channel's curve.
  let stroke: Color
  /// Human name of the active channel, used in accessibility labels.
  let channelName: String
  /// The live session, drawn as a ghost histogram behind the curve.
  let session: EditSession?
  /// Called with a new point list on every accepted edit.
  let onChange: ([ToneCurvePoint]) -> Void
  /// Opens history before the first write and closes it at release.
  let onEditingChanged: (Bool) -> Void
  let keyboardBridge: ToneCurveKeyboardBridge?
  let onKeyHandlerChanged: (((KeyPress) -> KeyPress.Result)?) -> Void

  /// Knot hit radius, in authoring-domain units (≈ 8pt on a 220pt plot).
  private static let hitRadius = 0.05
  /// Vertical nudge per arrow-key press, in authoring-domain units.
  private static let keyStep = 1.0 / 64.0

  @FocusState private var focusedKnot: Int?
  #if os(iOS)
    @State private var knotResponders = ToneCurveKnotResponders()
  #endif
  @State private var insertedKnotFocus: Int?
  @State private var dragIndex: Int?
  @State private var dragPoints: [ToneCurvePoint]?
  @GestureState private var dragGestureActive = false

  /// What the plot shows: the in-flight drag list when one is live, else
  /// the committed model value.
  private var shownPoints: [ToneCurvePoint] { dragPoints ?? points }

  /// The knots as the overlay draws them — always materialised, so an
  /// identity curve still shows its two corner anchors to grab.
  private var knots: [ToneCurvePoint] { ToneCurveEditing.materialize(shownPoints) }

  var body: some View {
    GeometryReader { geo in
      // Keep the endpoint glyph and its focus ring inside the inspector's clip.
      // Canvas drawing and pointer conversion share the same inner square.
      let ringMargin: CGFloat = 10
      let size = max(0, min(geo.size.width, geo.size.height) - ringMargin * 2)
      ZStack {
        ZStack {
          histogramBackdrop
          Canvas { context, canvasSize in
            draw(context: context, size: canvasSize)
          }
        }
        .frame(width: size, height: size)
        .background(ProTokens.canvasAlt)
        .clipShape(RoundedRectangle(cornerRadius: MapleTokens.Radius.sm, style: .continuous))
        knotOverlay(size: size)
      }
      .frame(width: size, height: size)
      .overlay(
        RoundedRectangle(cornerRadius: MapleTokens.Radius.sm, style: .continuous)
          .stroke(ProTokens.border, lineWidth: 0.5)
          .allowsHitTesting(false)
      )
      .contentShape(Rectangle())
      .gesture(dragGesture(size: size))
      .padding(ringMargin)
      .frame(maxWidth: .infinity, alignment: .center)
    }
    .aspectRatio(1, contentMode: .fit)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-tone-curve-plot")
    .onChange(of: dragGestureActive) { old, new in
      if old && !new { endDrag() }
    }
    .onChange(of: knots.count) { _, _ in
      if let index = insertedKnotFocus {
        insertedKnotFocus = nil
        if knots.indices.contains(index) { focusKnot(index) }
      } else if let index = focusedKnot, !knots.indices.contains(index) {
        focusedKnot = nil
      }
    }
    .onChange(of: channelName) { _, _ in
      insertedKnotFocus = nil
      focusedKnot = nil
      #if os(iOS)
        knotResponders.resign()
      #endif
    }
    .onDisappear {

      insertedKnotFocus = nil
      focusedKnot = nil
      #if os(iOS)
        knotResponders.resign()
      #endif
      endDrag()
      #if os(iOS)
        keyboardBridge?.handle = nil
        keyboardBridge?.resign = nil
        onKeyHandlerChanged(nil)
      #endif
    }
    #if os(iOS)
      .onAppear {
        keyboardBridge?.handle = { press in knotResponders.handle(press) }
        keyboardBridge?.resign = { knotResponders.resign() }
        onKeyHandlerChanged { press in knotResponders.handle(press) }
      }
    #endif
  }

  // MARK: - Backdrop

  /// The same live histogram the pill header shows, dimmed to a ghost so
  /// the curve reads on top of it. Reusing `MiniHistogram` keeps the
  /// debounced, off-render-path loader in one place.
  private var histogramBackdrop: some View {
    MiniHistogram(session: session) { Color.clear }
      .opacity(0.22)
      .allowsHitTesting(false)
  }

  // MARK: - Canvas drawing

  private func draw(context: GraphicsContext, size: CGSize) {
    let w = size.width
    let h = size.height

    // Quarter grid.
    var grid = Path()
    for fraction in [0.25, 0.5, 0.75] {
      grid.move(to: CGPoint(x: w * fraction, y: 0))
      grid.addLine(to: CGPoint(x: w * fraction, y: h))
      grid.move(to: CGPoint(x: 0, y: h * fraction))
      grid.addLine(to: CGPoint(x: w, y: h * fraction))
    }
    context.stroke(grid, with: .color(.white.opacity(0.08)), lineWidth: 0.5)

    // Identity diagonal.
    var identity = Path()
    identity.move(to: CGPoint(x: 0, y: h))
    identity.addLine(to: CGPoint(x: w, y: 0))
    context.stroke(
      identity,
      with: .color(.white.opacity(0.20)),
      style: StrokeStyle(lineWidth: 0.75, dash: [3, 4])
    )

    // The curve. `ToneCurveMath.sample` is the port of the pipeline's
    // Fritsch–Carlson evaluator, so this is the shape that will render.
    let samples = ToneCurveMath.sample(shownPoints)
    guard let first = samples.first else { return }
    var curve = Path()
    curve.move(to: point(first, in: size))
    for sample in samples.dropFirst() {
      curve.addLine(to: point(sample, in: size))
    }
    context.stroke(
      curve,
      with: .color(stroke),
      style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)
    )
  }

  /// Authoring domain → view space. This is the ONE y flip; nothing else
  /// in the file inverts.
  private func point(_ p: ToneCurvePoint, in size: CGSize) -> CGPoint {
    CGPoint(x: p.x * size.width, y: (1 - p.y) * size.height)
  }

  // MARK: - Knot overlay

  private func knotOverlay(size: CGFloat) -> some View {
    let list = knots
    let count = list.count
    return ZStack(alignment: .topLeading) {
      ForEach(Array(list.enumerated()), id: \.offset) { index, knot in
        Group {
          #if os(iOS)
            ToneCurveNativeKnot(
              index: index, responders: knotResponders, fill: ProTokens.text,
              stroke: index == 0 || index == count - 1 ? Color.white.opacity(0.30) : stroke,
              strokeWidth: index == 0 || index == count - 1 ? 1 : 1.5,
              ring: ProTokens.accent,
              label: knotLabel(
                index: index, count: count, isPinned: index == 0 || index == count - 1),
              value: "\(Int((knot.y * 100).rounded()))",
              identifier: "editor-tone-curve-knot-\(index)",
              onArrow: { key in

                let list = ToneCurveEditing.materialize(shownPoints)
                guard list.indices.contains(index) else { return }
                let dx = key == .leftArrow ? -Self.keyStep : key == .rightArrow ? Self.keyStep : 0
                let dy = key == .downArrow ? -Self.keyStep : key == .upArrow ? Self.keyStep : 0
                move(index: index, x: list[index].x + dx, y: list[index].y + dy)
              },
              onAdjust: { direction in adjust(index: index, direction: direction) }
            ).frame(width: 9, height: 9)
          #else
            ToneCurveKnotMarker(
              isPinned: index == 0 || index == count - 1,
              tint: stroke,
              index: index,
              focus: $focusedKnot,
              onKey: { press in handleKey(press, index: index) },
              label: knotLabel(
                index: index, count: count, isPinned: index == 0 || index == count - 1),
              value: "\(Int((knot.y * 100).rounded()))",
              identifier: "editor-tone-curve-knot-\(index)",
              onAdjust: { direction in adjust(index: index, direction: direction) }
            )
          #endif
        }
        .position(point(knot, in: CGSize(width: size, height: size)))
      }
    }
    .frame(width: size, height: size, alignment: .topLeading)
  }

  private func focusKnot(_ index: Int) {
    #if os(iOS)
      knotResponders.focus(index)
    #else
      focusedKnot = index
    #endif
  }

  private func knotLabel(index: Int, count: Int, isPinned: Bool) -> String {
    let base = "\(channelName) curve point \(index + 1) of \(count)"
    return isPinned ? base + ", endpoint" : base
  }

  /// VoiceOver's increment / decrement on a focused knot — the keyboard
  /// equivalent of dragging it up or down.
  private func adjust(index: Int, direction: AccessibilityAdjustmentDirection) {
    let list = ToneCurveEditing.materialize(shownPoints)
    guard index >= 0, index < list.count else { return }
    let delta = direction == .increment ? Self.keyStep : -Self.keyStep
    move(index: index, x: list[index].x, y: list[index].y + delta)
  }

  // A focused knot owns arrows before the editor group/filmstrip route (#4384).
  private func handleKey(
    _ press: KeyPress, index: Int
  ) -> KeyPress.Result {

    guard press.modifiers.intersection([.command, .control, .option, .shift]).isEmpty else {
      return .ignored
    }
    guard press.phase != .up else { return .handled }
    let list = ToneCurveEditing.materialize(shownPoints)
    guard list.indices.contains(index) else { return .handled }
    let knot = list[index]
    let dx = press.key == .leftArrow ? -Self.keyStep : press.key == .rightArrow ? Self.keyStep : 0
    let dy = press.key == .downArrow ? -Self.keyStep : press.key == .upArrow ? Self.keyStep : 0
    move(index: index, x: knot.x + dx, y: knot.y + dy)
    return .handled
  }

  private func move(index: Int, x: Double, y: Double) {

    let moved = ToneCurveEditing.move(shownPoints, index: index, x: x, y: y)
    guard ToneCurve(points: moved) != ToneCurve(points: shownPoints) else { return }
    onEditingChanged(true)
    onChange(moved)
    onEditingChanged(false)
  }

  // MARK: - Drag

  private func dragGesture(size: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 0)
      .updating($dragGestureActive) { _, active, _ in active = true }
      .onChanged { value in
        let pos = authoring(value.location, size: size)
        if dragIndex == nil {
          beginDrag(at: pos)
        } else {
          continueDrag(to: pos)
        }
      }
      .onEnded { value in
        if dragIndex != nil { continueDrag(to: authoring(value.location, size: size)) }
        endDrag()
      }
  }

  /// Grab the knot under the finger, or insert one there and grab that.
  private func beginDrag(at pos: (x: Double, y: Double)) {

    let existing = ToneCurveEditing.hitTest(
      points, x: pos.x, y: pos.y, radius: Self.hitRadius
    )
    let next =
      existing != nil
      ? ToneCurveEditing.materialize(points)
      : ToneCurveEditing.insert(points, x: pos.x, y: pos.y)
    guard
      let index = existing
        ?? ToneCurveEditing.hitTest(next, x: pos.x, y: pos.y, radius: Self.hitRadius)
    else { return }

    // Snapshot for undo at the START of the gesture, so one drag is one
    // undo entry no matter how many writes it forwards.
    onEditingChanged(true)
    // A new point cannot take focus until its materialized overlay is published.
    // Existing points retain the ordinary pointer/Tab focus route.
    if existing == nil {
      insertedKnotFocus = index
    } else {
      insertedKnotFocus = nil
      focusKnot(index)
    }

    dragIndex = index
    dragPoints = next
    if ToneCurve(points: next) != ToneCurve(points: points) { onChange(next) }
  }

  private func continueDrag(to pos: (x: Double, y: Double)) {

    guard let index = dragIndex else { return }
    let next = ToneCurveEditing.move(shownPoints, index: index, x: pos.x, y: pos.y)
    // Paint immediately; the render scheduler coalesces superseded work.
    dragPoints = next
    if ToneCurve(points: next) != ToneCurve(points: points) { onChange(next) }
  }

  private func endDrag() {

    guard dragIndex != nil else { return }
    // Keep the final control point even if SwiftUI coalesced the last
    // gesture event with the release/cancellation update.
    if let final = dragPoints, ToneCurve(points: final) != ToneCurve(points: points) {
      onChange(final)
    }
    dragIndex = nil
    dragPoints = nil
    onEditingChanged(false)
  }

  /// View space → authoring domain.
  private func authoring(_ location: CGPoint, size: CGFloat) -> (x: Double, y: Double) {
    guard size > 0 else { return (0, 0) }
    return (x: location.x / size, y: 1 - location.y / size)
  }

}

// MARK: - ToneCurveKnotMarker

/// One control point, hoisted out of the `Canvas` so VoiceOver can reach it.
/// Split into its own view for the same reason the other editor markers are:
/// the modifier chain (fill + overlay stroke + position + four accessibility
/// modifiers) exceeds the Swift expression type-checker's budget when it is
/// inlined into a `ForEach` body.
private struct ToneCurveKnotMarker: View {
  let isPinned: Bool
  let tint: Color
  let index: Int
  let focus: FocusState<Int?>.Binding
  let onKey: (KeyPress) -> KeyPress.Result
  let label: String
  let value: String
  let identifier: String
  let onAdjust: (AccessibilityAdjustmentDirection) -> Void

  private var inputKeys: Set<KeyEquivalent> {
    [.leftArrow, .rightArrow, .upArrow, .downArrow]
  }

  private var strokeColor: Color { isPinned ? Color.white.opacity(0.30) : tint }
  private var strokeWidth: CGFloat { isPinned ? 1 : 1.5 }

  var body: some View {
    Circle()
      .fill(ProTokens.text)
      .overlay(Circle().stroke(strokeColor, lineWidth: strokeWidth))
      .frame(width: 9, height: 9)
      .overlay {
        if focus.wrappedValue == index {
          Circle().stroke(ProTokens.accent, lineWidth: 2).frame(width: 17, height: 17)
        }
      }
      .focusable().focused(focus, equals: index).focusEffectDisabled()
      .accessibilityElement()
      .accessibilityLabel(label)
      .accessibilityValue(value)
      .accessibilityHint("Arrow keys move the curve point. Tab moves to the next control.")
      .accessibilityIdentifier(identifier)
      .accessibilityAdjustableAction(onAdjust)
      .focusedValue(\.toneCurveKeyPress, { press in onKey(press) })
      .onKeyPress(
        keys: inputKeys,
        phases: [.down, .repeat, .up], action: { press in onKey(press) })
  }
}
