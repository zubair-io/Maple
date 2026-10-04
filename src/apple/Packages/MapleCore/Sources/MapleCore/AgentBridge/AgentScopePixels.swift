import CoreGraphics
import Foundation

/// A paired, bounded sRGB/coverage snapshot from one captured render (#4104).
struct AgentScopePixels: Sendable {
  let rgba: [UInt8]
  let width: Int
  let height: Int
  let weighted: Bool

  static func bufferRegion(_ region: AgentInspector.Region?, width: Int, height: Int) -> CGRect {
    let extent = CGRect(x: 0, y: 0, width: width, height: height)
    guard let region else { return extent }
    return CGRect(
      x: region.x * Double(width),
      y: (1 - region.y - region.height) * Double(height),
      width: region.width * Double(width), height: region.height * Double(height)
    )
    .integral.intersection(extent)
  }
}
