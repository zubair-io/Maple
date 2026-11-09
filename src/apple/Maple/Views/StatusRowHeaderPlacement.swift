import MapleCore
import SwiftUI

/// Places a floating header row 8 pt below the safe-area top. Where the
/// system's status items occupy only the trailing end of the top inset (the
/// open Duo, #5774), the row moves up into that inset instead: vertically
/// centred on the status items, its trailing edge clear of them.
struct StatusRowHeaderPlacement: ViewModifier {
  private static let rowHeight: CGFloat = 44
  private static let restingTop: CGFloat = 8
  private static let minimumHeaderWidth: CGFloat = 320
  /// Reserved-region edges can land a fraction of a point off the inset.
  private static let edgeTolerance: CGFloat = 1

  func body(content: Content) -> some View {
    GeometryReader { geometry in
      let statusRow = Self.statusRowInsets(in: geometry)
      content
        .padding(statusRow ?? EdgeInsets(top: Self.restingTop, leading: 0, bottom: 0, trailing: 0))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .ignoresSafeArea(.container, edges: statusRow == nil ? [] : .top)
    }
  }

  private static func statusRowInsets(in geometry: GeometryProxy) -> EdgeInsets? {
    #if os(iOS)
      guard MapleShellKind.currentIdiom == .phone else { return nil }
      return statusRowInsets(
        occlusions: geometry.occlusionFrames, size: geometry.size,
        safeArea: geometry.safeAreaInsets)
    #else
      return nil
    #endif
  }

  /// The row's padding from the screen top and the safe area's trailing
  /// edge when the status items, in safe-area coordinates, are centred in
  /// the top inset at its trailing end and leave a header's width beside
  /// them. A conventional iPhone's leading clock or centred sensor housing,
  /// and the closed Duo's side-rail clock, keep the resting row.
  static func statusRowInsets(occlusions: [CGRect], size: CGSize, safeArea: EdgeInsets)
    -> EdgeInsets?
  {
    let inTopInset = occlusions.filter { $0.midY < 0 }
    guard safeArea.top >= rowHeight, let first = inTopInset.first else { return nil }
    let cluster = inTopInset.dropFirst().reduce(first) { $0.union($1) }
    let trailingOnly =
      cluster.minX > size.width / 2
      && cluster.maxX <= size.width + safeArea.trailing + edgeTolerance
    let leavesHeaderRoom = cluster.minX >= minimumHeaderWidth
    guard trailingOnly && leavesHeaderRoom else { return nil }
    return EdgeInsets(
      top: max(0, safeArea.top + cluster.midY - rowHeight / 2), leading: 0, bottom: 0,
      trailing: size.width - cluster.minX)
  }
}

extension GeometryProxy {
  /// Screen areas the system covers, such as the Duo's status items. Empty
  /// where the OS cannot report them.
  var occlusionFrames: [CGRect] {
    #if os(iOS)
      if #available(iOS 27.1, *) {
        return reservedRegions(kind: .occlusion).map(\.frame)
      }
    #endif
    return []
  }
}

extension View {
  func statusRowHeaderPlacement() -> some View {
    modifier(StatusRowHeaderPlacement())
  }
}
