import SwiftUI

// MARK: - TapWithFrame

/// Tracks the view's window-space frame and hands it to `onTap`. The
/// frame is read through `onGeometryChange` (never a GeometryReader in
/// `body`, which would size the cell); the read is the same one the
/// optional `onFrameChange` publishes, so a cell pays for one watcher.
struct TapWithFrame: ViewModifier {
  let onTap: (CGRect) -> Void
  let onFrameChange: ((CGRect) -> Void)?
  /// A reference, not `@State` value storage: the global frame changes on
  /// every scroll frame for every visible cell, and writing it into
  /// `@State` would re-evaluate each cell's body per frame. The box holds
  /// the latest frame for the tap to read without invalidating anything.
  #if !os(macOS)
    @State private var latest = FrameBox()
  #endif

  func body(content: Content) -> some View {
    #if os(macOS)
      // Mac grids do not use the phone Preview hero's global tile frame.
      // A global geometry subscription here runs for every visible tile on
      // every scroll tick even though the Mac tap handler discards the rect.
      content.contentShape(Rectangle()).onTapGesture { onTap(.zero) }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onTap(.zero) }
    #else
      let isWatched = onFrameChange != nil
      content
        // Before the tap, so a tap anywhere in the cell's box counts.
        .contentShape(Rectangle())
        .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { new in
          latest.frame = new
          onFrameChange?(new)
        }
        // Geometry only reports on change. A cell that becomes the selected
        // one while it sits still (paging in Preview to a tile already on
        // screen — the scroll-into-view is a no-op) must report where it
        // already is, or the close would shrink into the wrong tile.
        .onChange(of: isWatched) { _, watched in
          if watched { onFrameChange?(latest.frame) }
        }
        .onTapGesture { onTap(latest.frame) }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onTap(latest.frame) }
    #endif
  }
}

/// Latest global frame of a cell (see `TapWithFrame`).
private final class FrameBox {
  var frame: CGRect = .zero
}
