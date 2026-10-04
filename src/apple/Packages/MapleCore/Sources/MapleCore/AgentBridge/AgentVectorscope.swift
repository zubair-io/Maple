import CoreGraphics
import CoreImage
import Foundation
import MapleAgentWire
import RawPipeline

/// Computes display-referred Rec.709 chroma distribution and vectorscope
/// metrics from rendered sRGB pixels, optionally isolated by a local mask or ROI.
///
/// The shared Rust scope reducer owns the chroma transform, confidence
/// thresholds and skin-line heuristic; hosts only capture its encoded input.
public enum AgentVectorscope {
  private static let reference = try! reduce(
    rgba: [0, 0, 0, 255], width: 1, height: 1, weighted: false)
  public static let skinToneLineAngleDeg = reference.skin_line_deg
  public static let skinToneLineWedgeDeg = reference.skin_wedge_deg
  public static let minSampleCountForEvidence = Int(reference.minimum_samples)

  public struct Result: Sendable, Equatable {
    public let basis: String
    public let convention: String
    public let targetHintDeg: Double
    public let targetWedgeDeg: Double
    public let hasSkinTarget: Bool
    public let maskId: String?
    public let sampleCount: Int
    public let insufficientEvidence: Bool
    public let skinLocusAngleDeg: Double?
    public let deviationDeg: Double?
    public let meanCb: Double
    public let meanCr: Double
    public let confidence: String
    public let warning: String?

    public var json: JSONValue {
      var dict: [String: JSONValue] = [
        "basis": .string(basis),
        "convention": .string(convention),
        "target_hint_deg": .number(targetHintDeg),
        "target_wedge_deg": .number(targetWedgeDeg),
        "has_skin_target": .bool(hasSkinTarget),
        "sample_count": .int(sampleCount),
        "insufficient_evidence": .bool(insufficientEvidence),
        "mean_cb": .number(meanCb),
        "mean_cr": .number(meanCr),
        "confidence": .string(confidence),
      ]
      if let maskId { dict["mask_id"] = .string(maskId) }
      if let skinLocusAngleDeg { dict["skin_locus_angle_deg"] = .number(skinLocusAngleDeg) }
      if let deviationDeg { dict["deviation_deg"] = .number(deviationDeg) }
      if let warning { dict["warning"] = .string(warning) }
      return .object(dict)
    }
  }

  /// Color math and evidence thresholds come exclusively from raw-core.
  static func reduce(rgba: [UInt8], width: Int, height: Int, weighted: Bool) throws
    -> MapleScopeEvidence
  {
    guard width > 0, height > 0, width <= ScopeSnapshot.maxDim, height <= ScopeSnapshot.maxDim,
      rgba.count == width * height * 4
    else {
      throw AgentError(
        code: "invalid_arguments", message: "Invalid bounded scope pixels or weights.")
    }
    var evidence = MapleScopeEvidence()
    let rc = rgba.withUnsafeBufferPointer { pixels in
      maple_scope_evidence(
        pixels.baseAddress, UInt(pixels.count), UInt32(width), UInt32(height), weighted ? 1 : 0,
        &evidence
      )
    }
    guard rc == 0 else {
      throw AgentError(
        code: "render_unavailable",
        message: maple_last_error().map { String(cString: $0) } ?? "Scope reduction failed.")
    }
    return evidence
  }

  public static func compute(
    rgba: [UInt8], width: Int, height: Int, maskWeights: [UInt8]? = nil,
    hasSkinTarget: Bool, maskId: String? = nil
  ) -> Result {
    do {
      guard width > 0, height > 0, width <= ScopeSnapshot.maxDim, height <= ScopeSnapshot.maxDim,
        maskWeights == nil || maskWeights?.count == width * height
      else {
        throw AgentError(code: "invalid_arguments", message: "Incomplete scope mask weights.")
      }
      var paired = rgba
      if let maskWeights, width > 0, height > 0, paired.count == width * height * 4 {
        for index in maskWeights.indices { paired[index * 4 + 3] = maskWeights[index] }
      }
      return result(
        try reduce(rgba: paired, width: width, height: height, weighted: maskWeights != nil),
        hasSkinTarget: hasSkinTarget, maskId: maskId)
    } catch {
      return result(
        reference, hasSkinTarget: hasSkinTarget, maskId: maskId,
        invalid: "Invalid or incomplete scope pixels/weights.")
    }
  }

  static func result(
    _ evidence: MapleScopeEvidence, hasSkinTarget: Bool, maskId: String?, invalid: String? = nil
  ) -> Result {
    let insufficient = evidence.confidence == 0
    let warning: String? =
      invalid
      ?? (insufficient
        ? (evidence.sample_count == 0
          ? "No chromatic samples found."
          : "Fewer than \(evidence.minimum_samples) chromatic samples (\(evidence.sample_count)). Insufficient evidence to establish a reliable chroma locus.")
        : (!hasSkinTarget
          ? "Whole-image vectorscope without a skin mask cannot reliably isolate skin from similarly colored surfaces (wood, sand, walls). Create or select a skin mask to evaluate skin locus."
          : nil))
    return Result(
      basis: "Rec.709 display-referred sRGB", convention: "0deg = +Cb, CCW towards +Cr",
      targetHintDeg: evidence.skin_line_deg, targetWedgeDeg: evidence.skin_wedge_deg,
      hasSkinTarget: hasSkinTarget, maskId: maskId, sampleCount: Int(evidence.sample_count),
      insufficientEvidence: insufficient,
      skinLocusAngleDeg: hasSkinTarget && !insufficient ? evidence.angle_deg : nil,
      deviationDeg: hasSkinTarget && !insufficient ? evidence.deviation_deg : nil,
      meanCb: evidence.mean_cb, meanCr: evidence.mean_cr,
      confidence: invalid != nil
        ? "none" : ["insufficient", "low", "moderate", "high"][Int(evidence.confidence)],
      warning: warning)
  }

  /// Apply the same display ROI and sampling transform to RGB and canonical
  /// coverage. The coverage image stays scalar/unmanaged, never gamma-converted.
  static func capturePixels(
    canvas: CIImage, weights: CIImage?, region: AgentInspector.Region?, context: CIContext
  ) throws -> AgentScopePixels {
    let extent = canvas.extent.integral
    guard extent.width.isFinite, extent.height.isFinite, extent.width >= 1, extent.height >= 1,
      extent.width <= Double(UInt32.max), extent.height <= Double(UInt32.max)
    else {
      throw AgentError(
        code: "render_unavailable", message: "The current render has invalid dimensions.")
    }
    // Bound the CPU materialization to the display resolution. The final
    // ROI sampler is shared Rust/WGSL box sampling, including coverage.
    let scale = min(1, 2048 / max(extent.width, extent.height))
    let width = max(1, Int((extent.width * scale).rounded()))
    let height = max(1, Int((extent.height * scale).rounded()))
    func aligned(_ image: CIImage) -> CIImage {
      let source = image.extent
      return image.transformed(by: CGAffineTransform(translationX: -source.minX, y: -source.minY))
        .transformed(
          by: CGAffineTransform(
            scaleX: CGFloat(width) / source.width, y: CGFloat(height) / source.height))
    }
    let bounds = CGRect(x: 0, y: 0, width: width, height: height)
    guard let sRGB = CGColorSpace(name: CGColorSpace.sRGB) else {
      throw AgentError(
        code: "render_unavailable", message: "Could not create the sRGB scope space.")
    }
    var pixels = [Float](repeating: 0, count: width * height * 4)
    pixels.withUnsafeMutableBytes { buffer in
      context.render(
        aligned(canvas), toBitmap: buffer.baseAddress!, rowBytes: width * 16,
        bounds: bounds, format: .RGBAf, colorSpace: sRGB)
    }
    if let weights {
      guard weights.extent.width > 0, weights.extent.height > 0 else {
        throw AgentError(code: "render_unavailable", message: "Missing canonical mask coverage.")
      }
      var coverage = [Float](repeating: 0, count: width * height)
      coverage.withUnsafeMutableBytes { buffer in
        context.render(
          aligned(weights), toBitmap: buffer.baseAddress!, rowBytes: width * 4,
          bounds: bounds, format: .Rf, colorSpace: nil)
      }
      guard coverage.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }) else {
        throw AgentError(code: "render_unavailable", message: "Invalid canonical mask coverage.")
      }
      for index in coverage.indices { pixels[index * 4 + 3] = coverage[index] }
    }
    let rect = AgentScopePixels.bufferRegion(region, width: width, height: height)
    var rgba = [UInt8](repeating: 0, count: ScopeSnapshot.maxDim * ScopeSnapshot.maxDim * 4)
    var outWidth: UInt32 = 0
    var outHeight: UInt32 = 0
    let rc = pixels.withUnsafeBufferPointer { input in
      rgba.withUnsafeMutableBufferPointer { output in
        maple_scope_snapshot_f32(
          input.baseAddress, UInt(input.count), UInt32(width), UInt32(height),
          UInt32(rect.minX), UInt32(rect.minY), UInt32(rect.width), UInt32(rect.height),
          weights != nil ? 1 : 0, output.baseAddress, UInt(output.count), &outWidth, &outHeight)
      }
    }
    guard rc == 0 else {
      throw AgentError(
        code: "render_unavailable",
        message: maple_last_error().map { String(cString: $0) } ?? "Scope snapshot failed.")
    }
    return AgentScopePixels(
      rgba: Array(rgba.prefix(Int(outWidth * outHeight * 4))),
      width: Int(outWidth), height: Int(outHeight), weighted: weights != nil)
  }
}
