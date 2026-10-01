import CoreGraphics
import Foundation

public enum MaskHandle: String, CaseIterable, Sendable {
  case linearStart, linearEnd, linearBody
  case radialCenter, radialRadiusX, radialRadiusY, radialRotate

  public var label: String {
    switch self {
    case .linearStart: return "Gradient start"
    case .linearEnd: return "Gradient end"
    case .linearBody: return "Gradient position"
    case .radialCenter: return "Mask center"
    case .radialRadiusX: return "Horizontal radius"
    case .radialRadiusY: return "Vertical radius"
    case .radialRotate: return "Mask rotation"
    }
  }
}

/// The same normalized handle positions and drag semantics as Web's mask-geometry.ts.
public enum MaskHandleGeometry {
  public static func handles(_ mask: LocalMask) -> [(handle: MaskHandle, point: MaskPoint)] {
    switch mask {
    case .linear(let start, let end, _):
      return [
        (.linearStart, start), (.linearEnd, end),
        (.linearBody, MaskPoint(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2)),
      ]
    case .radial(let center, let radii, let angle, _, _):
      let c = cos(angle)
      let s = sin(angle)
      return [
        (.radialCenter, center),
        (.radialRadiusX, MaskPoint(x: center.x + radii.x * c, y: center.y + radii.x * s)),
        (.radialRadiusY, MaskPoint(x: center.x - radii.y * s, y: center.y + radii.y * c)),
        (
          .radialRotate, MaskPoint(x: center.x + radii.x * 1.3 * c, y: center.y + radii.x * 1.3 * s)
        ),
      ]
    default: return []
    }
  }

  public static func outline(_ mask: LocalMask) -> [MaskPoint] {
    switch mask {
    case .linear(let start, let end, _): return [start, end]
    case .radial(let center, let radii, let angle, _, _):
      return (0...72).map { index in
        let t = Double(index) * 2 * .pi / 72
        let x = radii.x * cos(t)
        let y = radii.y * sin(t)
        return MaskPoint(
          x: center.x + x * cos(angle) - y * sin(angle),
          y: center.y + x * sin(angle) + y * cos(angle))
      }
    default: return []
    }
  }

  public static func screenPoint(_ point: MaskPoint, fullFrame: CGRect, angleDegrees: Double)
    -> CGPoint
  {
    RetouchOverlayGeometry.screenPoint(
      RetouchPoint(x: point.x, y: point.y), fullFrame: fullFrame, angleDegrees: angleDegrees)
  }
  public static func normalizedPoint(_ point: CGPoint, fullFrame: CGRect, angleDegrees: Double)
    -> MaskPoint
  {
    let p = RetouchOverlayGeometry.normalizedPoint(
      from: point, fullFrame: fullFrame, angleDegrees: angleDegrees)
    return MaskPoint(x: p.x, y: p.y)
  }

  public static func drag(
    _ mask: LocalMask, handle: MaskHandle, to point: MaskPoint, anchor: MaskPoint
  ) -> LocalMask {
    guard point.x.isFinite, point.y.isFinite else { return mask }
    switch mask {
    case .linear(let start, let end, let feather):
      switch handle {
      case .linearStart: return .linear(start: point, end: end, feather: feather)
      case .linearEnd: return .linear(start: start, end: point, feather: feather)
      case .linearBody:
        let dx = min(1 - max(start.x, end.x), max(-min(start.x, end.x), point.x - anchor.x))
        let dy = min(1 - max(start.y, end.y), max(-min(start.y, end.y), point.y - anchor.y))
        return .linear(
          start: MaskPoint(x: start.x + dx, y: start.y + dy),
          end: MaskPoint(x: end.x + dx, y: end.y + dy), feather: feather)
      default: return mask
      }
    case .radial(let center, let radii, let angle, let feather, let invert):
      let dx = point.x - center.x
      let dy = point.y - center.y
      switch handle {
      case .radialCenter:
        return .radial(center: point, radii: radii, angle: angle, feather: feather, invert: invert)
      case .radialRadiusX:
        return .radial(
          center: center,
          radii: MaskPoint(x: max(0.01, abs(dx * cos(angle) + dy * sin(angle))), y: radii.y),
          angle: angle, feather: feather, invert: invert)
      case .radialRadiusY:
        return .radial(
          center: center,
          radii: MaskPoint(x: radii.x, y: max(0.01, abs(-dx * sin(angle) + dy * cos(angle)))),
          angle: angle, feather: feather, invert: invert)
      case .radialRotate:
        return .radial(
          center: center, radii: radii, angle: atan2(dy, dx), feather: feather, invert: invert)
      default: return mask
      }
    default: return mask
    }
  }
}
