#if os(macOS)
  import AppKit
  import MapleCore
  import SwiftUI

  /// SwiftUI's original `.draggable` carries one item. AppKit provides one
  /// real file per selected photo on every supported macOS version (#4632).
  struct MacAssetDragSource: NSViewRepresentable {
    let payload: DraggedAssetPayload
    let thumbnail: CGImage?

    func makeNSView(context: Context) -> DragView { DragView() }

    func updateNSView(_ view: DragView, context: Context) {
      view.payload = payload
      view.thumbnail = thumbnail
    }

    static func dismantleNSView(_ view: DragView, coordinator: ()) { view.stopMonitoring() }

    final class DragView: NSView, NSDraggingSource {
      var payload: DraggedAssetPayload?
      var thumbnail: CGImage?
      private var monitor: Any?
      private var mouseDown: NSEvent?
      private var items: [MacAssetDragItem] = []

      deinit { if let monitor { NSEvent.removeMonitor(monitor) } }

      // Keep the SwiftUI cell's click, double-click and context menu handling.
      override func hitTest(_ point: NSPoint) -> NSView? { nil }

      override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        stopMonitoring()
        guard window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(
          matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]
        ) { [weak self] event in
          guard let self else { return event }
          return self.handle(event)
        }
      }

      func stopMonitoring() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        mouseDown = nil
      }

      private func handle(_ event: NSEvent) -> NSEvent? {
        guard event.window === window else { return event }
        switch event.type {
        case .leftMouseDown:
          let point = convert(event.locationInWindow, from: nil)
          guard bounds.contains(point), visibleRect.contains(point) else {
            mouseDown = nil
            return event
          }
          if let content = window?.contentView,
            let hit = content.hitTest(content.convert(event.locationInWindow, from: nil)),
            hit is NSTextView || hit is NSTextField
          {
            mouseDown = nil
            return event
          }
          mouseDown = event
        case .leftMouseUp:
          mouseDown = nil
        case .leftMouseDragged:
          guard let down = mouseDown,
            hypot(
              event.locationInWindow.x - down.locationInWindow.x,
              event.locationInWindow.y - down.locationInWindow.y) >= 5,
            let payload, let assets = payload.resolveAssets?(), !assets.isEmpty
          else { return event }
          mouseDown = nil
          items = assets.map { MacAssetDragItem(asset: $0) }
          let image = dragImage(count: assets.count)
          let point = convert(down.locationInWindow, from: nil)
          let frame = NSRect(
            x: point.x - image.size.width / 2,
            y: point.y - image.size.height / 2, width: image.size.width, height: image.size.height)
          let draggingItems = items.map { item in
            let dragging = NSDraggingItem(pasteboardWriter: item)
            dragging.setDraggingFrame(frame, contents: image)
            return dragging
          }
          let session = beginDraggingSession(with: draggingItems, event: event, source: self)
          session.draggingFormation = .pile
          session.animatesToStartingPositionsOnCancelOrFail = true
          return nil
        default: break
        }
        return event
      }

      private func dragImage(count: Int) -> NSImage {
        let host = NSHostingView(
          rootView: AssetDragPreview(thumbnail: thumbnail, count: count).padding(6))
        let size = host.fittingSize
        host.frame = NSRect(origin: .zero, size: size)
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
          return NSWorkspace.shared.icon(for: .image)
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let image = NSImage(size: size)
        image.addRepresentation(bitmap)
        return image
      }

      func draggingSession(
        _ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext
      ) -> NSDragOperation {
        Self.operationMask(for: context)
      }

      static func operationMask(for context: NSDraggingContext) -> NSDragOperation {
        context == .outsideApplication ? .copy : [.copy, .move]
      }

      func draggingSession(
        _ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation
      ) {
        items = []
      }
    }
  }
#endif
