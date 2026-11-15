import MapleCore
import SwiftUI

/// Only the selected leaf owns handles; the separate tint shows the whole group.
struct MaskGeometryHandles: View {
  @Bindable var state: EditorState
  let displayRect: CGRect
  let projection: MaskProjection
  @State private var dragStart: LocalMask?
  @State private var dragAnchor: MaskPoint?
  @State private var haptics = EditorHapticPulse()
  private var session: EditSession { state.session }

  var body: some View {
    if let mask = session.selectedMaskGeometry, !session.showingOriginal {
      ZStack(alignment: .topLeading) {
        Path { path in
          let points = MaskHandleGeometry.outline(mask)
          if let first = points.first {
            path.move(to: screen(first))
            for point in points.dropFirst() { path.addLine(to: screen(point)) }
          }
        }
        .stroke(.white.opacity(0.85), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        ForEach(MaskHandleGeometry.handles(mask), id: \.handle) { item in
          handleView(item.handle, point: item.point)
        }
      }
      .coordinateSpace(name: "maskGeometryCanvas")
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Mask geometry")
      .onDisappear { finishDrag() }
      .onChange(of: session.selectedMaskId) { _, _ in finishDrag() }
      .onChange(of: session.selectedMaskComponentIndex) { _, _ in finishDrag() }
      .editorHaptics(haptics)
    }
  }

  private func handleDot(_ handle: MaskHandle, point: MaskPoint) -> some View {
    Circle()
      .fill(.white)
      .frame(width: 10, height: 10)
      .overlay(Circle().stroke(.black.opacity(0.8), lineWidth: 1))
      .frame(width: 44, height: 44)
      .contentShape(Circle())
      .position(screen(point))
      .gesture(drag(handle))
  }
  private func handleView(_ handle: MaskHandle, point: MaskPoint) -> some View {
    handleDot(handle, point: point).accessibilityElement()
      .accessibilityLabel(handle.label)
      .accessibilityValue(
        "\(point.x.formatted(.percent.precision(.fractionLength(0)))) across, \(point.y.formatted(.percent.precision(.fractionLength(0)))) down"
      )
      .accessibilityIdentifier("editor-mask-handle-\(handle.rawValue)")
      .accessibilityAdjustableAction { direction in
        switch direction {
        case .increment: adjust(handle, amount: 0.01)
        case .decrement: adjust(handle, amount: -0.01)
        @unknown default: break
        }
      }
      .accessibilityAction(named: "Move left") { move(handle, dx: -0.01, dy: 0) }
      .accessibilityAction(named: "Move right") { move(handle, dx: 0.01, dy: 0) }
      .accessibilityAction(named: "Move up") { move(handle, dx: 0, dy: -0.01) }
      .accessibilityAction(named: "Move down") { move(handle, dx: 0, dy: 0.01) }
  }

  private func screen(_ point: MaskPoint) -> CGPoint {
    MaskOverlayGeometry.screenPoint(point, displayRect: displayRect, projection: projection)
      ?? CGPoint(x: -10_000, y: -10_000)
  }
  private func normalized(_ point: CGPoint) -> MaskPoint? {
    MaskOverlayGeometry.normalizedPoint(
      point, displayRect: displayRect, projection: projection)
  }
  private func drag(_ handle: MaskHandle) -> some Gesture {
    DragGesture(minimumDistance: 0, coordinateSpace: .named("maskGeometryCanvas"))
      .onChanged { value in
        guard let point = normalized(value.location) else { return }
        if dragStart == nil {
          guard let anchor = normalized(value.startLocation) else { return }
          dragStart = session.selectedMaskGeometry
          dragAnchor = anchor
          session.setMaskDragActive(true)
          haptics.play(.grab)
        }
        guard let start = dragStart, let anchor = dragAnchor else { return }
        session.setMaskGeometry(
          MaskHandleGeometry.drag(
            start, handle: handle, to: point, anchor: anchor))
      }
      .onEnded { _ in finishDrag() }
  }
  private func finishDrag() {
    guard dragStart != nil else { return }
    session.setMaskDragActive(false)
    dragStart = nil
    dragAnchor = nil
  }
  private func move(_ handle: MaskHandle, dx: Double, dy: Double) {
    guard let mask = session.selectedMaskGeometry,
      let point = MaskHandleGeometry.handles(mask).first(where: { $0.handle == handle })?.point
    else { return }
    apply(
      mask, handle: handle,
      point: MaskPoint(x: min(1, max(0, point.x + dx)), y: min(1, max(0, point.y + dy))),
      anchor: point)
  }
  private func adjust(_ handle: MaskHandle, amount: Double) {
    guard let mask = session.selectedMaskGeometry,
      let point = MaskHandleGeometry.handles(mask).first(where: { $0.handle == handle })?.point
    else { return }
    if case .radial(let center, _, let angle, _, _) = mask {
      let a = handle == .radialRotate ? angle + amount * 5 : angle
      let dx = handle == .radialRadiusY ? -sin(a) : cos(a)
      let dy = handle == .radialRadiusY ? cos(a) : sin(a)
      let target =
        handle == .radialRotate
        ? MaskPoint(x: center.x + 0.1 * cos(a), y: center.y + 0.1 * sin(a))
        : MaskPoint(x: point.x + amount * dx, y: point.y + amount * dy)
      apply(mask, handle: handle, point: target, anchor: point)
    } else {
      move(handle, dx: amount, dy: 0)
    }
  }
  private func apply(_ mask: LocalMask, handle: MaskHandle, point: MaskPoint, anchor: MaskPoint) {
    session.setMaskDragActive(true)
    session.setMaskGeometry(
      MaskHandleGeometry.drag(mask, handle: handle, to: point, anchor: anchor))
    session.setMaskDragActive(false)
  }
}
