// MuiPad2D.swift — Maple UI Molecules-L1 ("2-D Pad" in
// unified-component-catalog.md §2.1). Two-axis draggable puck over a
// rectangular gradient field (e.g. white-balance temp/tint); a primitive
// plot with no atom dependency. A self-contained design-system
// re-implementation of the web reference's `mui-pad-2d`.
//
// A press anywhere on the pad moves the puck there, so a fingertip, an
// Apple Pencil and a pointer all place it directly. A hovering Pencil or
// pointer previews where a press would land.

import SwiftUI

public struct MuiPad2DValue: Equatable, Sendable {
  /// `[-1, 1]`, right positive.
  public var x: Double
  /// `[-1, 1]`, up positive.
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}

/// What paints the pad's field.
public enum MuiPad2DFill {
  /// One gradient from the top-leading to the bottom-trailing corner.
  case diagonal([Color])
  /// One gradient per axis: `horizontal` runs leading to trailing, and
  /// `vertical` runs top to bottom, multiplied over it.
  case axes(horizontal: Gradient, vertical: Gradient)
}

public enum MuiPad2DDirection: Sendable {
  case left, right, up, down
}

public struct MuiPad2D: View {
  @Binding public var value: MuiPad2DValue
  /// Side of the square pad. `nil` fills the frame its container offers,
  /// the web reference's `fill` mode.
  public let size: CGFloat?
  public let fill: MuiPad2DFill
  /// Draws guide lines through the puck across the whole pad.
  public let crosshair: Bool
  public let accessibilityLabel: String
  /// The value in the consumer's own terms (e.g. "5200 K, tint +4") for
  /// assistive technology. Falls back to the raw x/y pair.
  public let valueText: String?
  public let disabled: Bool
  /// `true` before the first change of a drag or key sequence, `false`
  /// once it ends. One pair brackets one undoable edit.
  public let onEditingChanged: ((Bool) -> Void)?
  /// A consumer with its own value domain steps the value itself for arrow
  /// keys and assistive actions: it returns the step's write, or `nil` when
  /// the value already sits at that edge, so a clamped key opens no edit.
  /// `nil` steps by `0.05`.
  public let onStep: ((MuiPad2DDirection) -> (() -> Void)?)?
  /// Receives the value under a hovering Pencil or pointer, and `nil`
  /// when it leaves. Setting it shows the hover preview.
  public let onHover: ((MuiPad2DValue?) -> Void)?

  @Environment(\.isEnabled) private var isEnabled
  @FocusState private var focused: Bool
  @GestureState private var dragging = false
  @State private var editing = false
  @State private var hover: MuiPad2DValue?

  private static let step = 0.05
  private static let puckDiameter: CGFloat = 12

  public init(
    value: Binding<MuiPad2DValue>,
    size: CGFloat? = 96,
    fill: MuiPad2DFill = .diagonal([.blue, MuiTokens.surfaceAlt, .orange]),
    crosshair: Bool = false,
    accessibilityLabel: String = "2-D pad",
    valueText: String? = nil,
    disabled: Bool = false,
    onEditingChanged: ((Bool) -> Void)? = nil,
    onStep: ((MuiPad2DDirection) -> (() -> Void)?)? = nil,
    onHover: ((MuiPad2DValue?) -> Void)? = nil
  ) {
    self._value = value
    self.size = size
    self.fill = fill
    self.crosshair = crosshair
    self.accessibilityLabel = accessibilityLabel
    self.valueText = valueText
    self.disabled = disabled
    self.onEditingChanged = onEditingChanged
    self.onStep = onStep
    self.onHover = onHover
  }

  private var interactive: Bool { isEnabled && !disabled }

  public var body: some View {
    GeometryReader { geometry in
      let box = geometry.size
      let puck = Self.location(of: value, in: box)
      ZStack {
        field
        if crosshair {
          Rectangle().fill(.white.opacity(0.35)).frame(height: 1)
            .position(x: box.width / 2, y: puck.y)
          Rectangle().fill(.white.opacity(0.35)).frame(width: 1)
            .position(x: puck.x, y: box.height / 2)
        }
        if let hover, !editing {
          Circle().stroke(.white.opacity(0.75), lineWidth: 1)
            .frame(width: Self.puckDiameter, height: Self.puckDiameter)
            .position(Self.location(of: hover, in: box))
        }
        Circle()
          .fill(Color.white)
          .frame(width: Self.puckDiameter, height: Self.puckDiameter)
          .shadow(color: .black.opacity(0.45), radius: 1)
          .overlay {
            if focused || editing {
              Circle().stroke(MuiTokens.primary, lineWidth: 2)
                .frame(width: Self.puckDiameter + 6, height: Self.puckDiameter + 6)
            }
          }
          .position(puck)
      }
      .contentShape(Rectangle())
      .gesture(drag(in: box))
      .onContinuousHover(coordinateSpace: .local) { phase in hoverChanged(phase, in: box) }
    }
    .frame(width: size, height: size)
    .opacity(interactive ? 1 : 0.45)
    .focusable(interactive).focused($focused).focusEffectDisabled()
    .onKeyPress(
      keys: [.leftArrow, .rightArrow, .upArrow, .downArrow], phases: [.down, .repeat, .up]
    ) { press in
      guard interactive, press.modifiers.intersection([.command, .control, .option]).isEmpty
      else { return .ignored }
      if press.phase == .up {
        finish()
        return .handled
      }
      switch press.key {
      case .leftArrow: step(.left)
      case .rightArrow: step(.right)
      case .upArrow: step(.up)
      default: step(.down)
      }
      return .handled
    }
    .onChange(of: dragging) { _, active in if !active { finish() } }
    .onChange(of: focused) { _, hasFocus in if !hasFocus { finish() } }
    .onChange(of: interactive) { _, _ in clearHover() }
    .onDisappear {
      finish()
      clearHover()
    }
    .accessibilityElement()
    .accessibilityLabel(accessibilityLabel)
    .accessibilityValue(valueText ?? String(format: "x %.2f, y %.2f", value.x, value.y))
    .accessibilityAdjustableAction { direction in
      guard interactive else { return }
      step(direction == .increment ? .right : .left)
      finish()
    }
    .accessibilityAction(named: "Move up") {
      guard interactive else { return }
      step(.up)
      finish()
    }
    .accessibilityAction(named: "Move down") {
      guard interactive else { return }
      step(.down)
      finish()
    }
  }

  @ViewBuilder private var field: some View {
    let shape = RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous)
    Group {
      switch fill {
      case .diagonal(let colors):
        shape.fill(
          LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing))
      case .axes(let horizontal, let vertical):
        ZStack {
          shape.fill(
            LinearGradient(gradient: horizontal, startPoint: .leading, endPoint: .trailing))
          shape.fill(LinearGradient(gradient: vertical, startPoint: .top, endPoint: .bottom))
            .blendMode(.multiply)
        }
        .compositingGroup()
      }
    }
    .overlay(shape.stroke(MuiTokens.border, lineWidth: 1))
  }

  private func drag(in box: CGSize) -> some Gesture {
    DragGesture(minimumDistance: 0)
      .updating($dragging) { _, active, _ in active = true }
      .onChanged { gesture in
        guard interactive else { return }
        focused = true
        move(to: Self.value(atLocation: gesture.location, in: box))
      }
      .onEnded { gesture in
        if interactive { move(to: Self.value(atLocation: gesture.location, in: box)) }
        finish()
      }
  }

  private func move(to next: MuiPad2DValue) {
    guard next != value else { return }
    begin()
    value = next
  }

  /// One key or assistive step. The edit opens only when the step moves the
  /// value: opening one starts an undo step, which drops the redo stack.
  private func step(_ direction: MuiPad2DDirection) {
    guard let write = stepWrite(direction) else { return }
    begin()
    write()
  }

  /// The write one step in `direction` makes, or `nil` when the value is
  /// already at that edge.
  func stepWrite(_ direction: MuiPad2DDirection) -> (() -> Void)? {
    if let onStep { return onStep(direction) }
    let next = Self.stepped(value, direction)
    guard next != value else { return nil }
    return { value = next }
  }

  private func begin() {
    guard !editing else { return }
    editing = true
    onEditingChanged?(true)
  }

  private func finish() {
    guard editing else { return }
    editing = false
    onEditingChanged?(false)
  }

  private func hoverChanged(_ phase: HoverPhase, in box: CGSize) {
    guard onHover != nil else { return }
    guard interactive, case .active(let location) = phase else {
      clearHover()
      return
    }
    let next = Self.value(atLocation: location, in: box)
    guard next != hover else { return }
    hover = next
    onHover?(next)
  }

  private func clearHover() {
    guard hover != nil else { return }
    hover = nil
    onHover?(nil)
  }

  /// The `x`/`y` value for a pointer at `location` within a square pad of
  /// `size` points. Public + static so this is unit-testable without
  /// running a gesture.
  public static func value(atLocation location: CGPoint, size: CGFloat) -> MuiPad2DValue {
    value(atLocation: location, in: CGSize(width: size, height: size))
  }

  /// The `x`/`y` value for a pointer at `location` within a pad of `box`.
  public static func value(atLocation location: CGPoint, in box: CGSize) -> MuiPad2DValue {
    guard box.width > 0, box.height > 0 else { return MuiPad2DValue(x: 0, y: 0) }
    let result = MuiPad2DMath.value(
      fracX: Double(location.x / box.width), fracY: Double(location.y / box.height))
    return MuiPad2DValue(x: result.x, y: result.y)
  }

  /// Where `value` sits within a pad of `box`, the inverse of
  /// `value(atLocation:in:)`.
  public static func location(of value: MuiPad2DValue, in box: CGSize) -> CGPoint {
    let puck = MuiPad2DMath.puckPosition(x: value.x, y: value.y)
    return CGPoint(x: box.width * puck.leftPct / 100, y: box.height * puck.topPct / 100)
  }

  /// `value` moved one built-in key step in `direction`, clamped.
  public static func stepped(
    _ value: MuiPad2DValue, _ direction: MuiPad2DDirection
  ) -> MuiPad2DValue {
    var next = value
    switch direction {
    case .left: next.x = MuiPad2DMath.clamp(value.x - step)
    case .right: next.x = MuiPad2DMath.clamp(value.x + step)
    case .up: next.y = MuiPad2DMath.clamp(value.y + step)
    case .down: next.y = MuiPad2DMath.clamp(value.y - step)
    }
    return next
  }
}

#Preview("MuiPad2D") {
  struct Demo: View {
    @State private var diagonal = MuiPad2DValue(x: 0.2, y: -0.3)
    @State private var axes = MuiPad2DValue(x: -0.1, y: 0)

    var body: some View {
      VStack(spacing: 24) {
        HStack(spacing: 24) {
          MuiPad2D(value: $diagonal)
          MuiPad2D(value: .constant(MuiPad2DValue(x: 0, y: 0)), disabled: true)
        }
        MuiPad2D(
          value: $axes, size: nil,
          fill: .axes(
            horizontal: Gradient(colors: [.blue, .gray, .orange]),
            vertical: Gradient(colors: [.pink.opacity(0.4), .clear, .green.opacity(0.35)])),
          crosshair: true, onHover: { _ in }
        )
        .aspectRatio(2, contentMode: .fit)
        .frame(width: 280)
      }
      .padding()
      .background(MuiTokens.bg)
    }
  }
  return Demo()
}
