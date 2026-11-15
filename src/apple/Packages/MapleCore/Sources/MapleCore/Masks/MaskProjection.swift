import CoreGraphics
import Foundation

public struct MaskProjection: Equatable, Sendable {
  public var values: [Double]

  public init(values: [Double]) {
    precondition(values.count == 9, "A mask projection has nine entries")
    self.values = values
  }

  public static let identity = MaskProjection(values: [1, 0, 0, 0, 1, 0, 0, 0, 1])

  public func apply(_ p: MaskPoint) -> MaskPoint? {
    let m = values
    let w = m[6] * p.x + m[7] * p.y + m[8]
    guard w.isFinite, abs(w) >= 1e-9 else { return nil }
    let point = MaskPoint(
      x: (m[0] * p.x + m[1] * p.y + m[2]) / w,
      y: (m[3] * p.x + m[4] * p.y + m[5]) / w)
    guard point.x.isFinite, point.y.isFinite else { return nil }
    return point
  }

  public func inverted() -> MaskProjection? {
    let m = values
    let c0 = m[4] * m[8] - m[5] * m[7]
    let c1 = m[5] * m[6] - m[3] * m[8]
    let c2 = m[3] * m[7] - m[4] * m[6]
    let det = m[0] * c0 + m[1] * c1 + m[2] * c2
    guard det.isFinite, abs(det) >= 1e-12 else { return nil }
    return MaskProjection(
      values: [
        c0, m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
        c1, m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
        c2, m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
      ].map { $0 / det })
  }

  public static func presentationToFrame(
    crop: Crop, perspective: Perspective, nativeSize: CGSize
  ) -> MaskProjection {
    let cropAffine = MaskAffine.cropToFullFrame(crop, nativeSize: nativeSize)
    let cropMatrix: [Double] = [
      cropAffine.a, cropAffine.c, cropAffine.tx,
      cropAffine.b, cropAffine.d, cropAffine.ty,
      0, 0, 1,
    ]
    let aspect =
      nativeSize.height > 0 && nativeSize.width.isFinite && nativeSize.height.isFinite
      ? Double(nativeSize.width / nativeSize.height) : 1
    let geometry = Self.rebased(Self.inverted(Self.perspectiveMatrix(perspective, aspect: aspect)))
    return MaskProjection(values: Self.multiply(geometry, cropMatrix))
  }

  private static func perspectiveMatrix(_ p: Perspective, aspect: Double) -> [Double] {
    let kh = 0.5 * p.horizontal / 100
    let kv = 0.5 * p.vertical / 100
    let theta = p.rotate * .pi / 180
    let (sinT, cosT) = (sin(theta), cos(theta))
    let ar = aspect.isFinite && aspect > 0 ? aspect : 1
    let stretch = pow(1.5, p.aspect / 100)
    let scale = p.scale / 100
    let keystone: [Double] = [1, 0, 0, 0, 1, 0, kh, kv, 1]
    let rotation: [Double] = [
      cosT, -sinT / ar, 0,
      sinT * ar, cosT, 0,
      0, 0, 1,
    ]
    let aspectM: [Double] = [stretch, 0, 0, 0, 1 / stretch, 0, 0, 0, 1]
    let scaleM: [Double] = [scale, 0, 0, 0, scale, 0, 0, 0, 1]
    let offset: [Double] = [1, 0, p.x / 100, 0, 1, p.y / 100, 0, 0, 1]
    return multiply(offset, multiply(scaleM, multiply(aspectM, multiply(rotation, keystone))))
  }

  private static func rebased(_ h: [Double]) -> [Double] {
    let (row, w) = ([h[6], h[7], h[8]], h[8] - h[6] - h[7])
    let rebase = { (r: [Double]) -> [Double] in
      [r[0] + row[0], r[1] + row[1], (r[2] - r[0] - r[1] + w) / 2]
    }
    let top = rebase([h[0], h[1], h[2]])
    let mid = rebase([h[3], h[4], h[5]])
    return top + mid + [2 * row[0], 2 * row[1], w]
  }

  private static func inverted(_ m: [Double]) -> [Double] {
    MaskProjection(values: m).inverted()?.values ?? MaskProjection.identity.values
  }

  private static func multiply(_ a: [Double], _ b: [Double]) -> [Double] {
    var out = [Double](repeating: 0, count: 9)
    for row in 0..<3 {
      for col in 0..<3 {
        out[row * 3 + col] =
          a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col]
      }
    }
    return out
  }
}
