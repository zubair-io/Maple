import Combine
import SwiftUI

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/// Native text editors keep their own typing/undo contract. Scene shortcuts
/// must not turn Cmd-Z in a filename or numeric field into a photo edit.
@MainActor
enum EditorTextInput {
  static var hasFocus: Bool {
    #if os(macOS)
      NSApp.keyWindow?.firstResponder is NSTextView
    #else
      firstResponder is any UITextInput
    #endif
  }

  /// Resolve focus and history together for scene menu validation. A field
  /// with no undo manager still owns Undo; do not fall through to photo edits.
  static var historyTarget: (hasFocus: Bool, undoManager: UndoManager?) {
    #if os(macOS)
      let responder = NSApp.keyWindow?.firstResponder
      let hasFocus = responder is NSTextView
    #else
      let responder = firstResponder
      let hasFocus = responder is any UITextInput
    #endif
    return (hasFocus, hasFocus ? responder?.undoManager : nil)
  }

  #if !os(macOS)
    private static var firstResponder: UIView? {
      for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
        for window in scene.windows where window.isKeyWindow {
          if let responder = findResponder(window) { return responder }
        }
      }
      return nil
    }

    static func findResponder(_ view: UIView) -> UIView? {
      if view.isFirstResponder { return view }
      for subview in view.subviews {
        if let responder = findResponder(subview) { return responder }
      }
      return nil
    }
  #endif
}

/// A scene command's enablement must refresh when a native field starts
/// editing or its undo manager changes, even when no photo model changes.
@MainActor
final class EditorTextHistory: ObservableObject {
  @Published private(set) var revision = 0
  private var observation: AnyCancellable?

  init() {
    #if os(macOS)
      let editing: [Notification.Name] = [
        NSText.didBeginEditingNotification, NSText.didChangeNotification,
        NSText.didEndEditingNotification, NSControl.textDidBeginEditingNotification,
        NSControl.textDidChangeNotification, NSControl.textDidEndEditingNotification,
        NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
      ]
    #else
      let editing: [Notification.Name] = [
        UITextField.textDidBeginEditingNotification, UITextField.textDidChangeNotification,
        UITextField.textDidEndEditingNotification, UITextView.textDidBeginEditingNotification,
        UITextView.textDidChangeNotification, UITextView.textDidEndEditingNotification,
      ]
    #endif
    let names =
      editing + [
        .NSUndoManagerDidCloseUndoGroup, .NSUndoManagerDidUndoChange, .NSUndoManagerDidRedoChange,
      ]
    observation = Publishers.MergeMany(names.map { NotificationCenter.default.publisher(for: $0) })
      .sink { [weak self] _ in
        Task { @MainActor [weak self] in self?.revision += 1 }
      }
  }
}
