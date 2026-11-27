#if os(macOS)
  import AppKit
  import MapleCore
  import SwiftUI

  /// SwiftUI's original `.draggable` carries one item. AppKit provides one
  /// real file per selected photo on every supported macOS version (#4632).
  /// One view serves the whole grid and finds the cell under the mouse itself (#6159).
  struct MacAssetDragSource: NSViewRepresentable {
    let registry: MacAssetDragRegistry

    func makeNSView(context: Context) -> DragView { DragView(registry: registry) }

    func updateNSView(_ view: DragView, context: Context) {}

    static func dismantleNSView(_ view: DragView, coordinator: ()) { view.stopMonitoring() }

    final class DragView: NSView, NSDraggingSource {
      private let registry: MacAssetDragRegistry
      private var mouseDown: NSEvent?
      private var mouseDownCell: String?
      private var items: [MacAssetDragItem] = []

      init(registry: MacAssetDragRegistry) {
        self.registry = registry
        super.init(frame: .zero)
      }

      @available(*, unavailable)
      required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

      // Matches SwiftUI's top-left origin, so view points equal the registry's coordinate space.
      override var isFlipped: Bool { true }

      // Keep the SwiftUI cell's click, double-click and context menu handling.
      override func hitTest(_ point: NSPoint) -> NSView? { nil }

      override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        stopMonitoring()
        guard window != nil else { return }
        MacAssetDragMonitor.shared.register(self)
      }

      func stopMonitoring() {
        MacAssetDragMonitor.shared.unregister(self)
        mouseDown = nil
        mouseDownCell = nil
      }

      func containsMouseDown(_ event: NSEvent) -> Bool {
        guard event.window === window else { return false }
        let point = convert(event.locationInWindow, from: nil)
        guard bounds.contains(point), visibleRect.contains(point),
          registry.cellID(at: point) != nil
        else { return false }
        if let content = window?.contentView,
          let hit = content.hitTest(content.convert(event.locationInWindow, from: nil)),
          hit is NSTextView || hit is NSTextField
        {
          return false
        }
        return true
      }

      func handle(_ event: NSEvent) -> NSEvent? {
        guard event.window === window else { return event }
        switch event.type {
        case .leftMouseDown:
          mouseDown = event
          mouseDownCell = registry.cellID(at: convert(event.locationInWindow, from: nil))
        case .leftMouseUp:
          mouseDown = nil
          mouseDownCell = nil
        case .leftMouseDragged:
          guard let down = mouseDown,
            hypot(
              event.locationInWindow.x - down.locationInWindow.x,
              event.locationInWindow.y - down.locationInWindow.y) >= 5,
            let source = mouseDownCell.flatMap(registry.source(for:)),
            let assets = source.payload.resolveAssets?(), !assets.isEmpty
          else { return event }
          mouseDown = nil
          mouseDownCell = nil
          // A stacked tile hands Finder its JPEG too (#5050).
          items = assets.flatMap { asset in
            [MacAssetDragItem(asset: asset)]
              + (asset.stackCompanionDragAsset.map { [MacAssetDragItem(asset: $0)] } ?? [])
          }
          let image = dragImage(thumbnail: source.thumbnail, count: assets.count)
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

      private func dragImage(thumbnail: CGImage?, count: Int) -> NSImage {
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
