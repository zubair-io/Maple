// PipelineRenderer+P3Auto.swift — #4741.
//
// The Auto Profile cube is fit in sRGB-encoded space, so the CoreImage path
// used to pin every Auto render to an sRGB encode and apply the cube after
// it: a Display P3 canvas, native-detail patch or export never left the sRGB
// gamut, while the GPU-live P3 path keeps the wide gamut. On a P3 target the
// tail now runs inside raw-core's P3 encode (`rec2020_to_p3_auto_encoded`)
// from the same composed lattice the cube is baked from, and no cube is
// applied afterwards.

import CoreImage
import Foundation
import RawPipeline

extension AutoProfileLUT {
  /// The composed curve∘residual lattice behind an Auto cube, as raw-core reads
  /// it: `dimension`³ RGB, index `((b*n+g)*n+r)*3+c`.
  struct Lattice {
    let rgb: [Float]
    let dimension: Int
  }

  /// The lattice a filter `makeFilter(from:)` minted was baked from, held by
  /// the filter itself. A cache hit mints a fresh filter per render (#844), so
  /// the lattice rides each filter and hands back the cached cube's own
  /// storage, never a repack; it is released with the filter.
  enum MintedLattices {
    private final class Box {
      let lattice: Lattice
      init(_ lattice: Lattice) { self.lattice = lattice }
    }

    private static var key: UInt8 = 0

    static func register(_ lattice: Lattice, for filter: CIFilter) {
      objc_setAssociatedObject(filter, &key, Box(lattice), .OBJC_ASSOCIATION_RETAIN)
    }

    static func lattice(for filter: CIFilter) -> Lattice? {
      (objc_getAssociatedObject(filter, &key) as? Box)?.lattice
    }
  }

  /// The lattice of a cube minted by `makeFilter(from:)`, or `nil` when the
  /// filter carries no readable cube. A filter minted elsewhere is read back
  /// from its cube data.
  nonisolated static func lattice(of filter: CIFilter) -> Lattice? {
    MintedLattices.lattice(for: filter) ?? readLattice(of: filter)
  }

  private nonisolated static func readLattice(of filter: CIFilter) -> Lattice? {
    guard let dimension = filter.value(forKey: "inputCubeDimension") as? Int,
      let data = filter.value(forKey: "inputCubeData") as? Data,
      dimension >= 2,
      data.count == dimension * dimension * dimension * 4 * MemoryLayout<Float>.size
    else { return nil }
    let entries = dimension * dimension * dimension
    let rgb = data.withUnsafeBytes { raw in
      let rgba = raw.bindMemory(to: Float.self)
      return [Float](unsafeUninitializedCapacity: entries * 3) { out, count in
        for i in 0..<entries {
          out[i * 3] = rgba[i * 4]
          out[i * 3 + 1] = rgba[i * 4 + 1]
          out[i * 3 + 2] = rgba[i * 4 + 2]
        }
        count = entries * 3
      }
    }
    return Lattice(rgb: rgb, dimension: dimension)
  }
}

extension ImageEditPipeline {
  /// How one render reaches display values: the encode's primaries, the Auto
  /// lattice when the tail runs inside a P3 encode, and the cube CoreImage
  /// applies after an sRGB encode otherwise.
  struct DisplayEncodePlan {
    let target: CanvasColorSpace
    let p3Auto: AutoProfileLUT.Lattice?
    let cube: CIFilter?

    /// `requested` is the canvas setting, or `.srgb` when the caller composites
    /// an sRGB-baked film cube afterwards. An Auto cube keeps the sRGB encode
    /// unless the target is P3 and its lattice is readable.
    nonisolated static func resolve(requested: CanvasColorSpace, profileLUT: CIFilter?)
      -> DisplayEncodePlan
    {
      guard let profileLUT else {
        return DisplayEncodePlan(target: requested, p3Auto: nil, cube: nil)
      }
      if requested == .displayP3, let lattice = AutoProfileLUT.lattice(of: profileLUT) {
        return DisplayEncodePlan(target: .displayP3, p3Auto: lattice, cube: nil)
      }
      return DisplayEncodePlan(target: .srgb, p3Auto: nil, cube: profileLUT)
    }

    var colorSpace: CGColorSpace {
      target == .displayP3
        ? ImageEditPipeline.displayEncodedColorSpaceP3 : ImageEditPipeline.displayEncodedColorSpace
    }
  }
}

extension PipelineRenderer {
  /// `encodeDisplay` at Display P3 with the Auto tail applied inside the
  /// encode (`maple_encode_display_p3_auto_f32`).
  static func encodeDisplayP3Auto(
    inputBytes: Data, width: Int, height: Int, lattice: AutoProfileLUT.Lattice
  ) throws -> Data {
    let expectedBytes = try p3AutoExpectedBytes(inputBytes, width, height, "encodeDisplayP3Auto")
    var output = Data(count: expectedBytes)
    let rc = lattice.rgb.withUnsafeBufferPointer { lut in
      output.withUnsafeMutableBytes { outBuf -> Int32 in
        inputBytes.withUnsafeBytes { inBuf -> Int32 in
          maple_encode_display_p3_auto_f32(
            inBuf.bindMemory(to: Float.self).baseAddress!, UInt32(width), UInt32(height),
            lut.baseAddress!, UInt32(lattice.dimension),
            outBuf.bindMemory(to: Float.self).baseAddress!)
        }
      }
    }
    try throwOnFailure(rc)
    return output
  }

  /// The fused chain + P3 Auto encode
  /// (`maple_apply_chain_and_encode_display_p3_auto_f32`); a non-nil `window`
  /// runs the chain windowed for a native-detail patch, recovering dehaze
  /// with `haze`.
  static func applyChainAndEncodeDisplayP3Auto(
    inputBytes: Data,
    width: Int,
    height: Int,
    params: MapleAdjustmentParams,
    curves: ChainToneCurves,
    noiseProfile: [Float]?,
    localAdjustments: [LocalAdjustment],
    lattice: AutoProfileLUT.Lattice,
    window: MapleChainWindow? = nil,
    haze: HazeMap? = nil
  ) throws -> Data {
    let expectedBytes = try p3AutoExpectedBytes(
      inputBytes, width, height, "applyChainAndEncodeDisplayP3Auto")
    var output = Data(count: expectedBytes)
    let rc: Int32 = try withChainPointers(
      params, noiseProfile: noiseProfile, localAdjustments: localAdjustments
    ) { bound in
      var p = bound
      return try curves.withMapleToneCurves { curvesPtr in
        try lattice.rgb.withUnsafeBufferPointer { lut in
          try output.withUnsafeMutableBytes { outBuf -> Int32 in
            let outPtr = outBuf.bindMemory(to: Float.self).baseAddress!
            return inputBytes.withUnsafeBytes { inBuf -> Int32 in
              let inPtr = inBuf.bindMemory(to: Float.self).baseAddress!
              let encode = { (windowPtr: UnsafePointer<MapleChainWindow>?) -> Int32 in
                maple_apply_chain_and_encode_display_p3_auto_f32(
                  inPtr, UInt32(width), UInt32(height), &p, curvesPtr,
                  lut.baseAddress!, UInt32(lattice.dimension), windowPtr, haze?.pointer, outPtr)
              }
              guard let window else { return encode(nil) }
              return withUnsafePointer(to: window, encode)
            }
          }
        }
      }
    }
    try throwOnFailure(rc)
    return output
  }

  private static func p3AutoExpectedBytes(
    _ inputBytes: Data, _ width: Int, _ height: Int, _ name: String
  ) throws -> Int {
    guard width > 0, height > 0 else {
      throw PipelineError.renderFailed(
        code: 2, message: "\(name): zero dimension width=\(width) height=\(height)")
    }
    let expectedBytes = width * height * 4 * MemoryLayout<Float>.size
    guard inputBytes.count == expectedBytes else {
      throw PipelineError.renderFailed(
        code: 9, message: "\(name): input \(inputBytes.count) bytes != expected \(expectedBytes)")
    }
    return expectedBytes
  }

  private static func throwOnFailure(_ rc: Int32) throws {
    guard rc == 0 else {
      let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
      throw PipelineError.renderFailed(code: Int(rc), message: msg)
    }
  }
}
