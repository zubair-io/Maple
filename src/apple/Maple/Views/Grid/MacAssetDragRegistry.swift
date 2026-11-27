#if os(macOS)
  import MapleCore
  import SwiftUI

  /// Plain reference type: cells write into it from geometry callbacks without
  /// triggering any SwiftUI update, and the grid's one drag view reads it on mouse-down.
  @MainActor
  final class MacAssetDragRegistry {
    static let space = "mapleGridDragSpace"

    struct Source {
      let payload: DraggedAssetPayload
      let thumbnail: CGImage?
    }

    private var frames = CellFrameIndex<String>()
    private var sources: [String: Source] = [:]

    func recordFrame(_ frame: CGRect, for id: String) { frames.record(frame, for: id) }

    func setSource(_ source: Source, for id: String) { sources[id] = source }

    func refreshSource(_ source: Source, for id: String) {
      if frames.isOnScreen(id) { sources[id] = source }
    }

    func appeared(_ id: String) { frames.appeared(id) }

    /// Only on-screen cells hold a source, so a long session never retains every thumbnail it saw.
    func disappeared(_ id: String) {
      frames.disappeared(id)
      if !frames.isOnScreen(id) { sources[id] = nil }
    }

    func cellID(at point: CGPoint) -> String? { frames.cell(at: point) }

    func source(for id: String) -> Source? { sources[id] }
  }

  private struct MacAssetDragRegistryKey: EnvironmentKey {
    static let defaultValue: MacAssetDragRegistry? = nil
  }

  extension EnvironmentValues {
    var macAssetDragRegistry: MacAssetDragRegistry? {
      get { self[MacAssetDragRegistryKey.self] }
      set { self[MacAssetDragRegistryKey.self] = newValue }
    }
  }

  /// One AppKit drag view behind the whole grid instead of one per cell (#6159).
  struct MacGridDragHost: ViewModifier {
    let isEnabled: Bool
    @State private var registry = MacAssetDragRegistry()

    func body(content: Content) -> some View {
      if isEnabled {
        content
          .coordinateSpace(name: MacAssetDragRegistry.space)
          .environment(\.macAssetDragRegistry, registry)
          .background(MacAssetDragSource(registry: registry))
      } else {
        content
      }
    }
  }

  /// Registers one cell's frame and drag source with the grid's registry.
  struct MacCellDragRegistration: ViewModifier {
    let id: String
    let payload: DraggedAssetPayload
    let thumbnail: CGImage?
    @Environment(\.macAssetDragRegistry) private var registry

    func body(content: Content) -> some View {
      // Refreshed on every evaluation so a drag always sees the current selection and thumbnail.
      registry?.refreshSource(.init(payload: payload, thumbnail: thumbnail), for: id)
      return
        content
        .onGeometryChange(for: CGRect.self) {
          $0.frame(in: .named(MacAssetDragRegistry.space))
        } action: { frame in
          registry?.recordFrame(frame, for: id)
        }
        .onAppear {
          registry?.setSource(.init(payload: payload, thumbnail: thumbnail), for: id)
          registry?.appeared(id)
        }
        .onDisappear { registry?.disappeared(id) }
    }
  }
#endif
