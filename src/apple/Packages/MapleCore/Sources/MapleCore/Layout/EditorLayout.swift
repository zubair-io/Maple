import CoreGraphics

/// An iPhone's regular horizontal size class (Duo inner display) uses the
/// floating inspector. A wide but compact-class iPhone in landscape keeps
/// its phone controls. Width still determines the larger density tiers.
public struct EditorLayout: Equatable, Sendable {
  public let usesPhoneControls: Bool
  public let density: MapleLayout

  public init(width: CGFloat, idiom: MapleDeviceIdiom, regularHorizontalSizeClass: Bool) {
    usesPhoneControls =
      MapleShellKind.from(idiom: idiom) == .phoneTab
      && !regularHorizontalSizeClass
    density =
      usesPhoneControls
      ? .phone
      : (regularHorizontalSizeClass && width < 768 ? .tablet : MapleLayout.from(width: width))
  }
}
