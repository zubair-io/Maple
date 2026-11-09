import MapleCore
import OSLog
import SwiftUI

private let statusRowLog = Logger(subsystem: "app.justmaple.aperture", category: "status-row")

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

  let surface: String

  func body(content: Content) -> some View {
    GeometryReader { geometry in
      let inputs = PlacementInputs(geometry: geometry)
      let statusRow = inputs.statusRow
      content
        .padding(statusRow ?? EdgeInsets(top: Self.restingTop, leading: 0, bottom: 0, trailing: 0))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .ignoresSafeArea(.container, edges: statusRow == nil ? [] : .top)
        .onChange(of: inputs, initial: true) {
          if inputs.isPhone { inputs.log(surface: surface, global: geometry.frame(in: .global)) }
        }
    }
  }

  /// What decides the header row's placement. Phones log it once per
  /// change, so a device the simulator cannot reproduce can be read back.
  private struct PlacementInputs: Equatable {
    let isPhone: Bool
    let size: CGSize
    let safeArea: EdgeInsets
    let occlusions: [CGRect]

    init(geometry: GeometryProxy) {
      #if os(iOS)
        isPhone = MapleShellKind.currentIdiom == .phone
      #else
        isPhone = false
      #endif
      size = geometry.size
      safeArea = geometry.safeAreaInsets
      occlusions = isPhone ? geometry.occlusionFrames : []
    }

    var statusRow: EdgeInsets? {
      isPhone
        ? StatusRowHeaderPlacement.statusRowInsets(
          occlusions: occlusions, size: size, safeArea: safeArea)
        : nil
    }

    func log(surface: String, global: CGRect) {
      let geometry = "size \(size) safeArea \(safeArea) global \(global)"
      let decision = "occlusions \(occlusions) -> \(String(describing: statusRow))"
      statusRowLog.notice(
        "\(surface, privacy: .public): \(geometry, privacy: .public) \(decision, privacy: .public)")
    }
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
  func statusRowHeaderPlacement(surface: String) -> some View {
    modifier(StatusRowHeaderPlacement(surface: surface))
  }
}
