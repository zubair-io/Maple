#if os(macOS)
  import AppKit

  /// One event monitor for the grid, regardless of its thumbnail count.
  /// Hit-test only on mouse-down; subsequent events visit just the active cell.
  @MainActor
  final class MacAssetDragMonitor {
    static let shared = MacAssetDragMonitor()
    private let views = NSHashTable<MacAssetDragSource.DragView>.weakObjects()
    private weak var active: MacAssetDragSource.DragView?
    private var monitor: Any?

    func register(_ view: MacAssetDragSource.DragView) {
      views.add(view)
      guard monitor == nil else { return }
      monitor = NSEvent.addLocalMonitorForEvents(
        matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]
      ) { [weak self] event in
        guard let self else { return event }
        return self.handle(event)
      }
    }

    func unregister(_ view: MacAssetDragSource.DragView) {
      views.remove(view)
      if active === view { active = nil }
      if views.allObjects.isEmpty, let monitor {
        NSEvent.removeMonitor(monitor)
        self.monitor = nil
      }
    }

    private func handle(_ event: NSEvent) -> NSEvent? {
      if event.type == .leftMouseDown {
        active = views.allObjects.first { $0.containsMouseDown(event) }
      }
      guard let active else { return event }
      let result = active.handle(event)
      if event.type == .leftMouseUp || result == nil { self.active = nil }
      return result
    }
  }
#endif
