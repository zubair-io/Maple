#if os(macOS)
  import AppKit
  import SwiftUI

  /// An AppKit control so the export sheet can return keyboard focus to its trigger (#5410).
  struct NativeExportRecipesButton: NSViewRepresentable {
    let focusRequest: Int
    let action: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(action: action) }

    func makeNSView(context: Context) -> ExportButton {
      let button = ExportButton(
        title: "Export recipes…", target: context.coordinator,
        action: #selector(Coordinator.openRecipes))
      button.bezelStyle = .push
      button.setAccessibilityIdentifier("general.settings.exportRecipes")
      return button
    }

    func updateNSView(_ button: ExportButton, context: Context) {
      context.coordinator.action = action
      guard context.coordinator.lastFocusRequest != focusRequest else { return }
      context.coordinator.lastFocusRequest = focusRequest
      Task { @MainActor [weak button] in
        await Task.yield()
        guard let button, let window = button.window else { return }
        window.makeFirstResponder(button)
      }
    }

    final class Coordinator: NSObject {
      var action: () -> Void
      var lastFocusRequest = 0

      init(action: @escaping () -> Void) { self.action = action }

      @objc func openRecipes() { action() }
    }

    final class ExportButton: NSButton {
      override var acceptsFirstResponder: Bool { true }
    }
  }
#endif
