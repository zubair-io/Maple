import SwiftUI

/// Shared dimensions keep the crop viewport clear of the complete filmstrip,
/// including its collapse tab and the padding applied by the editor shell.
enum EditorCropGeometry {
  static let filmstripWidth: CGFloat = 110
  static let filmstripTabWidth: CGFloat = 20
  static let filmstripTabGap: CGFloat = 2
  static let filmstripLeadingPadding: CGFloat = 12
  static let handleMargin: CGFloat = 32

  /// The canvas host and crop overlay receive the same inset geometry, so
  /// the handles stay aligned with the image and inside the uncovered area.
  static func insets(
    size: CGSize, controlsFrame: CGRect?, isRegular: Bool, hasFilmstrip: Bool
  ) -> EdgeInsets {
    let coveredWidth = controlsFrame.map { max(0, size.width - $0.minX) } ?? 0
    let coveredHeight = controlsFrame.map { max(0, size.height - $0.minY) } ?? 0
    let filmstripEnd =
      filmstripLeadingPadding + filmstripWidth + filmstripTabGap + filmstripTabWidth
    return EdgeInsets(
      top: 76,
      leading: isRegular && hasFilmstrip ? filmstripEnd + handleMargin : handleMargin,
      bottom: isRegular ? handleMargin : max(handleMargin, coveredHeight + 16),
      trailing: isRegular ? max(handleMargin, coveredWidth + 16) : handleMargin
    )
  }
}
