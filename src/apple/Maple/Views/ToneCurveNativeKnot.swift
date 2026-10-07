#if os(iOS)
  import SwiftUI
  import UIKit

  /// The real responder for each materialized point in one tone-curve plot.
  @MainActor final class ToneCurveKnotResponders {
    private struct Entry { weak var view: ToneCurveKnotView? }
    private var entries: [Int: Entry] = [:]
    private var requestedIndex: Int?

    func register(_ view: ToneCurveKnotView, index: Int) { entries[index] = Entry(view: view) }
    func remove(_ view: ToneCurveKnotView, index: Int) {
      if entries[index]?.view === view { entries.removeValue(forKey: index) }
    }
    func contains(_ index: Int) -> Bool { entries[index]?.view != nil }
    func focus(_ index: Int) {

      requestedIndex = index
      guard let view = entries[index]?.view, view.window != nil else { return }
      UIFocusSystem.focusSystem(for: view)?.requestFocusUpdate(to: view)
      UIFocusSystem.focusSystem(for: view)?.updateFocusIfNeeded()
      _ = view.becomeFirstResponder()

    }
    func admitIfRequested(_ view: ToneCurveKnotView) {
      if requestedIndex == view.index { focus(view.index) }
    }
    func didResign(_ view: ToneCurveKnotView) {
      if requestedIndex == view.index,
        entries[view.index]?.view == nil || entries[view.index]?.view === view
      {
        requestedIndex = nil
      }
    }
    func handle(_ press: KeyPress) -> KeyPress.Result {
      if let view = entries.values.first(where: { $0.view?.isFirstResponder == true })?.view {
        return view.handle(press)
      }
      guard press.key == .tab || press.key == KeyEquivalent("\u{19}"),
        press.modifiers.intersection([.command, .control, .option]).isEmpty
      else { return .ignored }
      let reverse = press.modifiers.contains(.shift) || press.key == KeyEquivalent("\u{19}")
      guard let index = (reverse ? entries.keys.max() : entries.keys.min()) else { return .ignored }
      if press.phase == .down { focus(index) }
      return .handled
    }
    func resign() {
      requestedIndex = nil
      for entry in entries.values where entry.view?.isFirstResponder == true {
        _ = entry.view?.resignFirstResponder()
      }
    }
  }

  struct ToneCurveNativeKnot: UIViewRepresentable {
    let index: Int
    let responders: ToneCurveKnotResponders
    let fill: Color
    let stroke: Color
    let strokeWidth: CGFloat
    let ring: Color
    let label: String
    let value: String
    let identifier: String
    let onArrow: (KeyEquivalent) -> Void
    let onAdjust: (AccessibilityAdjustmentDirection) -> Void

    func makeUIView(context: Context) -> ToneCurveKnotView {
      let view = ToneCurveKnotView()
      view.index = index
      view.responders = responders
      responders.register(view, index: index)
      return view
    }

    func updateUIView(_ view: ToneCurveKnotView, context: Context) {
      view.fillColor = UIColor(fill)
      view.strokeColor = UIColor(stroke)
      view.strokeWidth = strokeWidth
      view.ringColor = UIColor(ring)
      view.accessibilityLabel = label
      view.accessibilityValue = value
      view.accessibilityIdentifier = identifier
      view.onArrow = onArrow
      view.onAdjust = onAdjust
      view.setNeedsDisplay()
    }

    static func dismantleUIView(_ view: ToneCurveKnotView, coordinator: ()) {
      view.responders?.remove(view, index: view.index)
      if view.isFirstResponder { _ = view.resignFirstResponder() }
    }
  }

  @MainActor final class ToneCurveKnotView: UIView {
    var index = 0
    weak var responders: ToneCurveKnotResponders?
    var fillColor = UIColor.white
    var strokeColor = UIColor.white
    var strokeWidth: CGFloat = 1
    var ringColor = UIColor.white { didSet { focusRing.strokeColor = ringColor.cgColor } }
    private let focusRing = CAShapeLayer()
    var onArrow: ((KeyEquivalent) -> Void)?
    var onAdjust: ((AccessibilityAdjustmentDirection) -> Void)?

    override init(frame: CGRect) {
      super.init(frame: frame)

      backgroundColor = .clear
      isOpaque = false
      clipsToBounds = false
      focusRing.fillColor = nil
      focusRing.lineWidth = 2
      focusRing.isHidden = true
      layer.addSublayer(focusRing)
      isAccessibilityElement = true
      accessibilityTraits = [.adjustable]
      accessibilityHint = "Arrow keys move the curve point. Tab moves to the next control."
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    override var canBecomeFirstResponder: Bool { true }
    override var canBecomeFocused: Bool { true }
    override func didMoveToWindow() {
      super.didMoveToWindow()
      if window != nil { responders?.admitIfRequested(self) }
    }

    override func becomeFirstResponder() -> Bool {
      let admitted = super.becomeFirstResponder()

      if admitted { focusRing.isHidden = false }
      return admitted
    }
    override func resignFirstResponder() -> Bool {
      let resigned = super.resignFirstResponder()

      if resigned {
        responders?.didResign(self)
        focusRing.isHidden = true
      }
      return resigned
    }
    override func didUpdateFocus(
      in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator
    ) {
      super.didUpdateFocus(in: context, with: coordinator)
      if context.nextFocusedView === self {
        _ = becomeFirstResponder()
      } else if context.previouslyFocusedView === self {
        _ = resignFirstResponder()
      }
    }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
      responders?.focus(index)
      super.touchesBegan(touches, with: event)
    }

    func handle(_ press: KeyPress) -> KeyPress.Result {
      guard isFirstResponder,
        press.modifiers.intersection([.command, .control, .option]).isEmpty
      else { return .ignored }

      if press.key == .tab || press.key == KeyEquivalent("\u{19}") {
        let next =
          index
          + (press.modifiers.contains(.shift) || press.key == KeyEquivalent("\u{19}") ? -1 : 1)
        guard responders?.contains(next) == true else { return .ignored }
        if press.phase == .down { responders?.focus(next) }
        return .handled
      }
      guard [.leftArrow, .rightArrow, .upArrow, .downArrow].contains(press.key) else {
        return .ignored
      }
      guard !press.modifiers.contains(.shift) else { return .ignored }
      if press.phase != .up { onArrow?(press.key) }
      return .handled
    }

    override func accessibilityIncrement() { onAdjust?(.increment) }
    override func accessibilityDecrement() { onAdjust?(.decrement) }

    override func layoutSubviews() {
      super.layoutSubviews()
      focusRing.path = UIBezierPath(ovalIn: bounds.insetBy(dx: -4, dy: -4)).cgPath
    }

    override func draw(_ rect: CGRect) {
      let glyph = UIBezierPath(ovalIn: bounds)
      fillColor.setFill()
      glyph.fill()
      strokeColor.setStroke()
      glyph.lineWidth = strokeWidth
      glyph.stroke()

    }
  }

#endif
