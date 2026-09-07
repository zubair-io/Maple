import MapleCore
import SwiftUI

/// One relative slider contract: a transaction per drag or held key, canonical
/// reset, 0.25× fine drag and accessible value keys (#3250).
public struct LivingSlider: View {
  let label: String
  @Binding var value: Double
  let range: ClosedRange<Double>
  let isBipolar: Bool
  let defaultValue: Double
  let gradientStops: [GradientStop]?
  let displayValue: String?
  let onEditingChanged: ((Bool) -> Void)?
  let onCommit: (() -> Void)?

  @Environment(\.isEnabled) private var isEnabled
  @FocusState private var focused: Bool
  @GestureState private var dragging = false
  @State private var dragStart: Double?
  @State private var dragStartTranslation: CGFloat = 0
  @State private var lastTranslation: CGFloat = 0
  @State private var interacting = false
  @State private var fineMode = false
  @State private var hapticTick = 0

  public init(
    label: String, value: Binding<Double>, range: ClosedRange<Double>,
    isBipolar: Bool = false, defaultValue: Double = 0,
    gradient: [GradientStop]? = nil, displayValue: String? = nil,
    onCommit: (() -> Void)? = nil, onEditingChanged: ((Bool) -> Void)? = nil
  ) {
    self.label = label
    self._value = value
    self.range = range
    self.isBipolar = isBipolar
    self.defaultValue = defaultValue
    self.gradientStops = gradient
    self.displayValue = displayValue
    self.onEditingChanged = onEditingChanged
    self.onCommit = onCommit
  }

  private var formattedValue: String {
    displayValue ?? LivingSliderMath.format(value: value, range: range)
  }

  private var isModified: Bool {
    LivingSliderMath.isModified(value: value, defaultValue: defaultValue, range: range)
  }

  private var gradient: LinearGradient {
    let stops =
      gradientStops?.map {
        Gradient.Stop(color: Color(red: $0.r, green: $0.g, blue: $0.b), location: $0.t)
      } ?? [
        Gradient.Stop(color: ProTokens.border, location: 0),
        Gradient.Stop(color: ProTokens.borderHi, location: 1),
      ]
    return LinearGradient(stops: stops, startPoint: .leading, endPoint: .trailing)
  }

  public var body: some View {
    VStack(spacing: 4) {
      HStack {
        Text(label).font(MapleTokens.Typography.toolLabel).foregroundStyle(ProTokens.textMuted)
        Spacer()
        Text(formattedValue).font(MapleTokens.Typography.valueChip).monospacedDigit()
          .foregroundStyle(isModified ? ProTokens.accent : ProTokens.textDim)
      }
      .accessibilityHidden(true)
      GeometryReader { geometry in
        let width = geometry.size.width
        let pct = LivingSliderMath.pctUnipolar(value: value, range: range)
        ZStack(alignment: .leading) {
          Capsule().fill(gradient).frame(height: 8)
            .overlay(Capsule().strokeBorder(ProTokens.borderHi, lineWidth: 0.5))
          if isBipolar {
            Rectangle().fill(.white.opacity(0.8)).frame(width: 1.5, height: 8)
              .position(x: width / 2, y: 8)
          }
          Circle().fill(.white).frame(width: 16, height: 16)
            .shadow(color: .black.opacity(0.45), radius: 1, y: 0.5)
            .overlay(
              Circle().strokeBorder(
                focused || isModified ? ProTokens.accent : .clear, lineWidth: 2)
            )
            .position(x: 8 + pct * max(width - 16, 0), y: 8)
        }
        .frame(height: 16).frame(maxHeight: .infinity).contentShape(Rectangle())
        .gesture(drag(width: max(width - 16, 1)))
        .highPriorityGesture(TapGesture(count: 2).onEnded { reset() })
        .simultaneousGesture(
          LongPressGesture(minimumDuration: 0.5).onEnded { _ in enableFineMode() })
      }
      .frame(height: 28).accessibilityHidden(true)
    }
    .padding(.horizontal, 16).padding(.vertical, 6).frame(minHeight: 44)
    .contentShape(Rectangle())
    .focusable(isEnabled).focused($focused).focusEffectDisabled()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label).accessibilityValue(formattedValue)
    .accessibilityHint(
      "Arrow keys adjust. Double-tap resets. Hold for fine adjustment."
    )
    .accessibilityAdjustableAction { direction in
      guard isEnabled else { return }
      let delta = direction == .increment ? 1.0 : -1.0
      update(value + delta * LivingSliderMath.keyboardStep(range: range))
      finish()
    }
    .accessibilityAction(named: "Reset") { reset() }
    .accessibilityAction(named: "Fine adjustment") { enableFineMode() }
    .onKeyPress(
      keys: [.leftArrow, .rightArrow, .upArrow, .downArrow, .home, .end],
      phases: [.down, .repeat, .up]
    ) { press in
      guard isEnabled, press.modifiers.intersection([.command, .control, .option]).isEmpty else {
        return .ignored
      }
      if press.phase == .up {
        finish()
        return .handled
      }
      let next: Double
      switch press.key {
      case .home: next = range.lowerBound
      case .end: next = range.upperBound
      default:
        let direction = press.key == .leftArrow || press.key == .downArrow ? -1.0 : 1.0
        next = value + direction * LivingSliderMath.keyboardStep(range: range)
      }
      update(next)
      return .handled
    }
    .onChange(of: focused) { _, hasFocus in if !hasFocus { finish() } }
    .onChange(of: dragging) { _, active in if !active { finish() } }
    .onDisappear { finish() }
    .sensoryFeedback(.selection, trigger: hapticTick)
  }

  private func drag(width: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 0)
      .updating($dragging) { _, active, _ in active = true }
      .onChanged { gesture in
        guard isEnabled else { return }
        focused = true
        if dragStart == nil { dragStart = value }
        lastTranslation = gesture.translation.width
        let delta =
          (lastTranslation - dragStartTranslation) / width
          * (range.upperBound - range.lowerBound)
        update((dragStart ?? value) + delta * (fineMode ? 0.25 : 1))
      }
      .onEnded { gesture in
        if let start = dragStart {
          let delta =
            (gesture.translation.width - dragStartTranslation) / width
            * (range.upperBound - range.lowerBound)
          update(start + delta * (fineMode ? 0.25 : 1))
        }
        finish()
      }
  }

  private func update(_ proposed: Double) {
    let next = min(max(proposed, range.lowerBound), range.upperBound)
    guard next != value else { return }
    if !interacting {
      onEditingChanged?(true)
      interacting = true
    }
    if next == range.lowerBound || next == range.upperBound
      || (value < defaultValue && next >= defaultValue)
      || (value > defaultValue && next <= defaultValue)
    {
      hapticTick += 1
    }
    value = next
  }

  private func finish() {
    if interacting {
      onEditingChanged?(false)
      onCommit?()
    }
    interacting = false
    dragStart = nil
    dragStartTranslation = 0
    lastTranslation = 0
    fineMode = false
  }

  private func enableFineMode() {
    guard isEnabled, !fineMode else { return }
    // The long press permits a little movement before it recognizes.
    // Anchor at that already-displayed value so sensitivity changes
    // affect only subsequent movement, without snapping backward.
    if dragStart != nil {
      dragStart = value
      dragStartTranslation = lastTranslation
    }
    fineMode = true
    hapticTick += 1
  }

  private func reset() {
    guard isEnabled else { return }
    finish()
    let resetFeedback = hapticTick + 1
    update(defaultValue)
    finish()
    // update already signals a default crossing; reset emits exactly one
    // selection trigger, including when the value was already the default.
    hapticTick = resetFeedback
  }
}
