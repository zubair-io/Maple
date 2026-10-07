// BrushRaster.swift — brush dab-series rasterization, digest and stroke
// math (#360).
//
// The render samples a brush layer's REGISTERED RASTER (an R8 plane in the
// process-wide registry, the same table bitmap masks use), while the model
// carries the DABS. This file bridges the two: `digest` names a stroke's
// raster, `rasterize` stamps it through `maple_brush_rasterize` (the stamp
// math is raw-core's, so every platform's strokes rasterize identically),
// and the stroke-capture helpers below turn pointer segments into dabs.
// No disk cache: unlike a Vision segmentation, a dab series re-rasterizes
// exactly and cheaply from the sidecar content, so there is nothing worth
// caching.

import Foundation
import RawPipeline

/// The brush tip — tool state, not layer state: every dab the overlay
/// stamps copies these values in. Lives on `EditSession`.
public struct BrushTip: Sendable, Equatable {
  /// Tip diameter as a fraction of the image width.
  public var size: Double
  /// Soft-edge fraction of the radius (`0` = hard disc).
  public var feather: Double
  /// Per-dab peak value.
  public var flow: Double
  /// Stamps subtract instead of adding.
  public var erase: Bool

  public init(size: Double, feather: Double, flow: Double, erase: Bool) {
    self.size = size
    self.feather = feather
    self.flow = flow
    self.erase = erase
  }

  public static let `default` = BrushTip(size: 0.05, feather: 0.5, flow: 0.5, erase: false)
}

public enum BrushRaster {
  /// `f32`s per dab on the `maple_brush_rasterize` wire — `x, y, radius,
  /// feather, weight, erase`, the same field order as the `crs:Dabs` XMP
  /// series and the wasm entry.
  public static let dabStride = 6

  /// Long edge of a brush raster in texels — mirrors raw-core's
  /// `BRUSH_RASTER_LONG_EDGE`, the same 1024 the Vision person/skin path
  /// registers at.
  public static let rasterLongEdge = 1024

  /// Dab spacing as a fraction of the radius — stamps overlap 4×, so even
  /// a fast drag lays an unbroken stroke.
  public static let dabSpacing = 0.25

  /// Stroke stabilizer: exponential-moving-average alpha toward the raw
  /// pointer point. `1` would disable smoothing entirely.
  public static let smoothingAlpha = 0.4

  /// Pointer-pressure response: `radius × (0.5 + 0.5p)`, `weight × (0.25 +
  /// 0.75p)` — a light touch paints small and faint, never invisible.
  public static let pressureRadiusFloor = 0.5
  public static let pressureWeightFloor = 0.25

  /// Aspect-preserving raster dims for an image — mirrors raw-core's
  /// `brush_raster_dims` exactly, so every platform rasterizes the same dab
  /// series onto the same grid.
  public static func rasterDims(imageWidth: Int, imageHeight: Int) -> (width: Int, height: Int) {
    let w = max(1, imageWidth)
    let h = max(1, imageHeight)
    let long = rasterLongEdge
    func short(_ a: Int, _ b: Int) -> Int { min(long, max(1, (a * long) / b)) }
    return w >= h ? (long, short(h, w)) : (short(w, h), long)
  }

  /// The 16-lowercase-hex digest naming a brush raster — FNV-1a over the
  /// dab payload (each dab's five `Float` bit patterns plus one erase
  /// byte), the same shape (not the same value: the payload serialization
  /// is host-local) as the web's `brushDigest`. Stable for identical
  /// strokes, so a re-parse finds the already-registered raster instead of
  /// re-registering.
  public static func digest(_ dabs: [BrushDab]) -> String {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    func mix(_ value: UInt64) {
      for shift in stride(from: 0, to: 64, by: 8) {
        hash ^= (value >> shift) & 0xff
        hash = hash &* 0x0000_0100_0000_01b3
      }
    }
    for dab in dabs {
      mix(UInt64(Float(dab.center.x).bitPattern))
      mix(UInt64(Float(dab.center.y).bitPattern))
      mix(UInt64(Float(dab.radius).bitPattern))
      mix(UInt64(Float(dab.feather).bitPattern))
      mix(UInt64(Float(dab.weight).bitPattern))
      hash ^= dab.erase ? 1 : 0
      hash = hash &* 0x0000_0100_0000_01b3
    }
    return String(format: "%016llx", hash)
  }

  /// Stamp `dabs` onto a `width × height` R8 grid through
  /// `maple_brush_rasterize`. Dabs with a non-finite `Float` field are
  /// dropped first — one bad stamp must not fail the whole upload the way
  /// the C entry's `-3` would. Nil only when the entry itself rejects the
  /// call (which a well-formed pack never triggers).
  public static func rasterize(dabs: [BrushDab], width: Int, height: Int) -> [UInt8]? {
    guard width > 0, height > 0 else { return nil }
    var wire: [Float] = []
    wire.reserveCapacity(dabs.count * dabStride)
    for dab in dabs {
      let fields = [
        Float(dab.center.x), Float(dab.center.y), Float(dab.radius),
        Float(dab.feather), Float(dab.weight),
      ]
      guard fields.allSatisfy({ $0.isFinite }) else { continue }
      wire.append(contentsOf: fields)
      wire.append(dab.erase ? 1 : 0)
    }
    var out = [UInt8](repeating: 0, count: width * height)
    let rc: Int32 =
      wire.withUnsafeBufferPointer { wireBuf in
        out.withUnsafeMutableBufferPointer { outBuf in
          maple_brush_rasterize(
            wireBuf.baseAddress, UInt(wire.count / dabStride),
            UInt32(width), UInt32(height), outBuf.baseAddress, UInt(outBuf.count))
        }
      }
    return rc == 0 ? out : nil
  }

  /// Pointer-pressure response: `0` (no sensor) reads as full pressure.
  public static func applyPressure(radius: Double, weight: Double, pressure: Double) -> (
    radius: Double, weight: Double
  ) {
    let p = pressure > 0 ? min(1, pressure) : 1
    return (
      radius * (pressureRadiusFloor + (1 - pressureRadiusFloor) * p),
      weight * (pressureWeightFloor + (1 - pressureWeightFloor) * p)
    )
  }

  /// The dab centres a pointer segment lays down, spaced `dabSpacing ×
  /// radius` apart so the stroke is unbroken at any drag speed. `aspect` is
  /// the image w/h — normalized units are not isotropic, so the segment
  /// length is measured in width-fractions. Always stamps at least `to` (a
  /// tap is one dab); never re-stamps `from` (the previous segment already
  /// did).
  public static func interpolateDabs(
    from: MaskPoint, to: MaskPoint, aspect: Double,
    radius: Double, feather: Double, weight: Double, erase: Bool
  ) -> [BrushDab] {
    let safeAspect = aspect.isFinite && aspect > 0 ? aspect : 1
    let dx = to.x - from.x
    let dy = (to.y - from.y) / safeAspect
    let spacing = max(radius * dabSpacing, 1e-9)
    // `hypot`, not a hand-rolled root: the web port pins exact dab counts
    // (`mask-brush.spec.ts`), and both must agree bit-for-bit on the
    // segment length for the same stroke to stamp the same dabs.
    let steps = max(1, Int(ceil(hypot(dx, dy) / spacing)))
    return (0..<steps).map { i in
      let t = Double(i + 1) / Double(steps)
      return BrushDab(
        center: MaskPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t),
        radius: radius, feather: feather, weight: weight, erase: erase)
    }
  }
}

/// Stroke stabilizer: an exponential moving average over the raw pointer
/// points. One instance per stroke — `reset` on press, `next` per move.
public final class StrokeSmoother: @unchecked Sendable {
  private var point: MaskPoint?

  public init() {}

  @discardableResult
  public func reset(_ p: MaskPoint) -> MaskPoint {
    point = p
    return p
  }

  public func next(_ p: MaskPoint) -> MaskPoint {
    let s = point ?? p
    let alpha = BrushRaster.smoothingAlpha
    let q = MaskPoint(x: s.x + (p.x - s.x) * alpha, y: s.y + (p.y - s.y) * alpha)
    point = q
    return q
  }
}
