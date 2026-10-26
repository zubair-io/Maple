// TouchActivityRecognizer.swift — reports every touch that begins anywhere
// in a window without ever claiming it, so the backup screen saver (#5457)
// can tell when someone last used the app.

#if os(iOS)
  import UIKit
  import UIKit.UIGestureRecognizerSubclass

  final class TouchActivityRecognizer: UIGestureRecognizer, UIGestureRecognizerDelegate {
    private let onTouch: @MainActor () -> Void

    init(onTouch: @escaping @MainActor () -> Void) {
      self.onTouch = onTouch
      super.init(target: nil, action: nil)
      cancelsTouchesInView = false
      delaysTouchesBegan = false
      delaysTouchesEnded = false
      delegate = self
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
      super.touchesBegan(touches, with: event)
      onTouch()
      // Failing straight away keeps every other recognizer and control in
      // the window working exactly as if this one weren't attached.
      state = .failed
    }

    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer,
      shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
      true
    }
  }
#endif
