import CoreGraphics

/// The editor's control family follows device identity; available width only
/// reflows the iPad/Mac inspector. A rotated iPhone retains compact controls.
public struct EditorLayout: Equatable, Sendable {
  public let usesPhoneControls: Bool
  public let density: MapleLayout

  public init(width: CGFloat, idiom: MapleDeviceIdiom) {
    usesPhoneControls = MapleShellKind.from(idiom: idiom) == .phoneTab
    density = usesPhoneControls ? .phone : MapleLayout.from(width: width)
  }
}
