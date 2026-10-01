// LocalAdjustmentFlat.swift — byte-for-byte Swift mirror of
// raw_core::types::local_adjustment::flat (#3274, extended by #3407).
// 40 Float32 per layer; the slot map is documented on that Rust file's
// header and MUST be kept in lockstep with it — a divergence here is a
// live-vs-fallback rendering bug, not a compile error.
//
// The map is APPEND-ONLY. The six spatial controls (#3407) took a new
// `vec4` pair at the tail (slots 32..38, presence bits 11..16, slots 38/39
// padding) rather than any interior padding slot, so every slot an earlier
// reader knows keeps its meaning. The stride is 40 rather than a tight 38
// because raw-gpu binds this array as ten WGSL `vec4<f32>` members, and a
// `vec4<f32>` has 16-byte alignment.

import Foundation

public enum LocalAdjustmentFlat {
  public static let layerFloatLen = LocalMaskWire.layerFlatLen

  private static let kindLinear = LocalMaskWire.kindLinear
  private static let kindRadial = LocalMaskWire.kindRadial
  private static let kindBitmap = LocalMaskWire.kindBitmap
  private static let kindEverywhere = LocalMaskWire.kindEverywhere
  private static let rangeKindColor: Float = 1

  private static let presentExposure: Int = 1 << 0
  private static let presentContrast: Int = 1 << 1
  private static let presentHighlights: Int = 1 << 2
  private static let presentShadows: Int = 1 << 3
  private static let presentWhites: Int = 1 << 4
  private static let presentBlacks: Int = 1 << 5
  private static let presentSaturation: Int = 1 << 6
  private static let presentVibrance: Int = 1 << 7
  private static let presentTemperature: Int = 1 << 8
  private static let presentTint: Int = 1 << 9
  private static let presentHue: Int = 1 << 10
  private static let presentTexture: Int = 1 << 11
  private static let presentClarity: Int = 1 << 12
  private static let presentDehaze: Int = 1 << 13
  private static let presentSharpness: Int = 1 << 14
  private static let presentLuminanceNoise: Int = 1 << 15
  private static let presentDefringe: Int = 1 << 16

  /// Slot index of the first spatial control (`texture`).
  private static let spatialBase = 32

  public static func toFlat(_ layers: [LocalAdjustment]) -> [Float] {
    let count = layers.reduce(0) { count, layer in
      if case .group(let group) = layer.mask { return count + 1 + group.components.count }
      return count + 1
    }
    var out = [Float](repeating: 0, count: count * layerFloatLen)
    var base = 0
    for layer in layers {
      writeMask(layer.mask, into: &out, base: base)
      writeAdjustments(layer.adjustments, into: &out, base: base)
      writeRange(layer.range, into: &out, base: base)
      base += layerFloatLen
      if case .group(let group) = layer.mask {
        for component in group.components {
          writeMask(component.mask, into: &out, base: base)
          let code =
            component.combine.rawValue * LocalMaskWire.componentCombineStride
            + (component.invert ? LocalMaskWire.componentInvertOffset : 0)
          out[base + 6] += LocalMaskWire.kindComponentBase + Float(code)
          base += layerFloatLen
        }
      }
    }
    return out
  }

  private static func writeMask(_ mask: LocalMask, into out: inout [Float], base: Int) {
    switch mask {
    case .linear(let start, let end, let feather):
      out[base + 0] = Float(start.x)
      out[base + 1] = Float(start.y)
      out[base + 2] = Float(end.x)
      out[base + 3] = Float(end.y)
      out[base + 4] = Float(feather)
      out[base + 6] = kindLinear
    case .radial(let center, let radii, let angle, let feather, let invert):
      out[base + 0] = Float(center.x)
      out[base + 1] = Float(center.y)
      out[base + 2] = Float(radii.x)
      out[base + 3] = Float(radii.y)
      out[base + 4] = Float(feather)
      out[base + 5] = Float(angle)
      out[base + 6] = kindRadial
      out[base + 7] = invert ? 1 : 0
    case .bitmap(_, let rasterId):
      out[base + 2] = Float(rasterId)
      out[base + 6] = kindBitmap
    case .everywhere:
      out[base + 6] = kindEverywhere
    case .group(let group):
      out[base] = Float(group.components.count)
      out[base + 1] = Float(group.opacity)
      out[base + 6] = LocalMaskWire.kindGroup
      out[base + 7] = group.invert ? 1 : 0
    }
  }

  /// The ten point controls on the contiguous `12..22` block, paired with
  /// their presence bits — one list so the writer and the reader below
  /// cannot disagree about which slot holds which control.
  private static func pointFields(_ a: PartialAdjustments) -> [(Double?, Int)] {
    [
      (a.exposure, presentExposure), (a.contrast, presentContrast),
      (a.highlights, presentHighlights),
      (a.shadows, presentShadows), (a.whites, presentWhites), (a.blacks, presentBlacks),
      (a.saturation, presentSaturation), (a.vibrance, presentVibrance),
      (a.temperature, presentTemperature), (a.tint, presentTint),
    ]
  }

  /// The six spatial controls (#3407) on the `32..38` block, same convention.
  private static func spatialFields(_ a: PartialAdjustments) -> [(Double?, Int)] {
    [
      (a.texture, presentTexture), (a.clarity, presentClarity), (a.dehaze, presentDehaze),
      (a.sharpness, presentSharpness), (a.luminanceNoise, presentLuminanceNoise),
      (a.defringe, presentDefringe),
    ]
  }

  private static func writeAdjustments(_ a: PartialAdjustments, into out: inout [Float], base: Int)
  {
    let point = pointFields(a)
    let spatial = spatialFields(a)
    let bits = { (acc: Int, entry: (Double?, Int)) in entry.0 == nil ? acc : acc | entry.1 }
    let present = spatial.reduce(point.reduce(a.hue == nil ? 0 : presentHue, bits), bits)
    out[base + 8] = Float(present)
    for (i, (value, _)) in point.enumerated() { out[base + 12 + i] = Float(value ?? 0) }
    out[base + 22] = Float(a.hue ?? 0)
    for (i, (value, _)) in spatial.enumerated() { out[base + spatialBase + i] = Float(value ?? 0) }
  }

  private static func writeRange(_ range: RangeRefinement?, into out: inout [Float], base: Int) {
    guard
      case .color(let hueDeg, let halfWidth, let chromaMin, let lMin, let lMax, let feather) = range
    else { return }
    out[base + 24] = rangeKindColor
    out[base + 25] = Float(hueDeg)
    out[base + 26] = Float(halfWidth)
    out[base + 27] = Float(chromaMin)
    out[base + 28] = Float(lMin)
    out[base + 29] = Float(lMax)
    out[base + 30] = Float(feather)
  }

  /// `rasterDigests` maps a resolved raster id (slot 2 of a bitmap record)
  /// to its digest, so a decoded `LocalMask.bitmap`'s recipe carries the right
  /// identity even though the flat wire itself only stores the id.
  public static func fromFlat(_ flat: [Float], rasterDigests: [UInt32: String]) -> [LocalAdjustment]
  {
    var layers: [LocalAdjustment] = []
    var base = 0
    let end = flat.count - flat.count % layerFloatLen
    while base < end {
      let mask: LocalMask
      let records: Int
      if flat[base + 6] == LocalMaskWire.kindGroup {
        guard let count = Int(exactly: flat[base]), count >= 0,
          count <= (end - base) / layerFloatLen - 1,
          let group = readGroup(flat, base: base, count: count, rasterDigests: rasterDigests)
        else { break }
        mask = .group(group)
        records = count + 1
      } else {
        guard let leaf = readMask(flat, base: base, rasterDigests: rasterDigests) else { break }
        mask = leaf
        records = 1
      }
      layers.append(
        LocalAdjustment(
          mask: mask,
          range: readRange(flat, base: base),
          adjustments: readAdjustments(flat, base: base)
        ))
      base += records * layerFloatLen
    }
    return layers
  }

  private static func readGroup(
    _ flat: [Float], base: Int, count: Int,
    rasterDigests: [UInt32: String]
  ) -> MaskGroup? {
    var components: [MaskComponent] = []
    for index in 0..<count {
      let child = base + (index + 1) * layerFloatLen
      guard let code = Int(exactly: flat[child + 6] - LocalMaskWire.kindComponentBase),
        code >= 0, code < LocalMaskWire.componentCodeCount,
        let combine = MaskCombine(
          rawValue: code % LocalMaskWire.componentInvertOffset
            / LocalMaskWire.componentCombineStride),
        let leaf = readMask(
          flat, base: child, rasterDigests: rasterDigests,
          kind: Float(code % LocalMaskWire.componentCombineStride)),
        let component = MaskComponent(
          mask: leaf, combine: combine,
          invert: code >= LocalMaskWire.componentInvertOffset)
      else { return nil }
      components.append(component)
    }
    return MaskGroup(
      components: components, opacity: Double(flat[base + 1]), invert: flat[base + 7] != 0)
  }

  private static func readMask(
    _ flat: [Float], base: Int, rasterDigests: [UInt32: String],
    kind explicitKind: Float? = nil
  ) -> LocalMask? {
    let kind = explicitKind ?? flat[base + 6]
    if kind == kindEverywhere { return .everywhere }
    if kind == kindBitmap {
      guard let rasterId = UInt32(exactly: flat[base + 2]) else { return nil }
      let digest = rasterDigests[rasterId] ?? ""
      return .bitmap(
        recipe: BitmapRecipe(
          person: 0, facialSkin: true, bodySkin: true, model: "", digest: digest),
        rasterId: rasterId
      )
    }
    if kind == kindRadial {
      return .radial(
        center: MaskPoint(x: Double(flat[base + 0]), y: Double(flat[base + 1])),
        radii: MaskPoint(x: Double(flat[base + 2]), y: Double(flat[base + 3])),
        angle: Double(flat[base + 5]), feather: Double(flat[base + 4]), invert: flat[base + 7] != 0
      )
    }
    guard kind == kindLinear else { return nil }
    return .linear(
      start: MaskPoint(x: Double(flat[base + 0]), y: Double(flat[base + 1])),
      end: MaskPoint(x: Double(flat[base + 2]), y: Double(flat[base + 3])),
      feather: Double(flat[base + 4])
    )
  }

  private static func readAdjustments(_ flat: [Float], base: Int) -> PartialAdjustments {
    let present = Int(exactly: flat[base + 8]) ?? 0
    func field(_ i: Int, _ bit: Int) -> Double? {
      present & bit != 0 ? Double(flat[base + 12 + i]) : nil
    }
    func spatial(_ i: Int, _ bit: Int) -> Double? {
      present & bit != 0 ? Double(flat[base + spatialBase + i]) : nil
    }
    return PartialAdjustments(
      exposure: field(0, presentExposure), contrast: field(1, presentContrast),
      highlights: field(2, presentHighlights),
      shadows: field(3, presentShadows), whites: field(4, presentWhites),
      blacks: field(5, presentBlacks),
      saturation: field(6, presentSaturation), vibrance: field(7, presentVibrance),
      temperature: field(8, presentTemperature), tint: field(9, presentTint),
      hue: present & presentHue != 0 ? Double(flat[base + 22]) : nil,
      texture: spatial(0, presentTexture), clarity: spatial(1, presentClarity),
      dehaze: spatial(2, presentDehaze), sharpness: spatial(3, presentSharpness),
      luminanceNoise: spatial(4, presentLuminanceNoise), defringe: spatial(5, presentDefringe)
    )
  }

  private static func readRange(_ flat: [Float], base: Int) -> RangeRefinement? {
    guard flat[base + 24] == rangeKindColor else { return nil }
    return .color(
      hueDeg: Double(flat[base + 25]), hueHalfWidthDeg: Double(flat[base + 26]),
      chromaMin: Double(flat[base + 27]),
      lMin: Double(flat[base + 28]), lMax: Double(flat[base + 29]), feather: Double(flat[base + 30])
    )
  }
}
