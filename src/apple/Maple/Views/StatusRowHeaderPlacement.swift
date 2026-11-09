import MapleCore
import OSLog
import SwiftUI

private let statusRowLog = Logger(subsystem: "app.justmaple.aperture", category: "status-row")

extension EnvironmentValues {
  /// The system's reserved status regions in window coordinates, measured at
  /// the app root (#5774). A pushed editor learns of them only a layout pass
  /// after it first appears, and may never be laid out again to see them.
  @Entry var statusRegions: [CGRect] = []
}

/// Measures the window's status regions at a view that is on screen before
/// any header is pushed.
private struct StatusRegionsMeasurement: ViewModifier {
  @State private var regions: [CGRect] = []

  func body(content: Content) -> some View {
    content
      .onGeometryChange(for: [CGRect].self) { proxy in
        StatusRowHeaderPlacement.windowRegions(
          proxy.occlusionFrames, origin: proxy.frame(in: .global).origin)
      } action: { measured in
        regions = measured
        let described = String(describing: measured)
        statusRowLog.notice("root: status regions \(described, privacy: .public)")
      }
      .environment(\.statusRegions, regions)
  }
}

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
  @Environment(\.statusRegions) private var statusRegions

  func body(content: Content) -> some View {
    GeometryReader { geometry in
      let inputs = PlacementInputs(geometry: geometry, statusRegions: statusRegions)
      let statusRow = inputs.statusRow
      content
        .padding(statusRow ?? EdgeInsets(top: Self.restingTop, leading: 0, bottom: 0, trailing: 0))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .ignoresSafeArea(.container, edges: statusRow == nil ? [] : .top)
        .onChange(of: inputs, initial: true) {
          if inputs.isPhone { inputs.log(surface: surface) }
        }
    }
  }

  /// What decides the header row's placement. Phones log it once per
  /// change, so a device the simulator cannot reproduce can be read back.
  private struct PlacementInputs: Equatable {
    let isPhone: Bool
    let size: CGSize
    let safeArea: EdgeInsets
    let origin: CGPoint
    let occlusions: [CGRect]

    init(geometry: GeometryProxy, statusRegions: [CGRect]) {
      #if os(iOS)
        isPhone = MapleShellKind.currentIdiom == .phone
      #else
        isPhone = false
      #endif
      size = geometry.size
      safeArea = geometry.safeAreaInsets
      origin = geometry.frame(in: .global).origin
      occlusions = geometry.statusRegions(window: statusRegions)
    }

    var statusRow: EdgeInsets? {
      isPhone
        ? StatusRowHeaderPlacement.statusRowInsets(
          occlusions: occlusions, size: size, safeArea: safeArea)
        : nil
    }

    func log(surface: String) {
      let geometry = "size \(size) safeArea \(safeArea) origin \(origin)"
      let decision = "occlusions \(occlusions) -> \(String(describing: statusRow))"
      statusRowLog.notice(
        "\(surface, privacy: .public): \(geometry, privacy: .public) \(decision, privacy: .public)")
    }
  }

  /// Converts regions between window space and the coordinates of a view
  /// at `origin` in window space.
  static func windowRegions(_ localRegions: [CGRect], origin: CGPoint) -> [CGRect] {
    localRegions.map { $0.offsetBy(dx: origin.x, dy: origin.y) }
  }

  static func localRegions(_ windowRegions: [CGRect], origin: CGPoint) -> [CGRect] {
    windowRegions.map { $0.offsetBy(dx: -origin.x, dy: -origin.y) }
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

  /// The status regions in this view's coordinates: its own reading once the
  /// system has reported them to it, else the app root's `window` reading.
  func statusRegions(window: [CGRect]) -> [CGRect] {
    let own = occlusionFrames
    return own.isEmpty
      ? StatusRowHeaderPlacement.localRegions(window, origin: frame(in: .global).origin) : own
  }
}

extension View {
  func statusRowHeaderPlacement(surface: String) -> some View {
    modifier(StatusRowHeaderPlacement(surface: surface))
  }

  func providesStatusRegions() -> some View {
    modifier(StatusRegionsMeasurement())
  }
}
