import CoreGraphics
import CoreImage
import Foundation
import MapleAgentWire

/// Computes display-referred Rec.709 chroma distribution and vectorscope
/// metrics from rendered sRGB pixels, optionally isolated by a local mask or ROI.
///
/// Rec.709 display-referred chroma:
///   Cb = -0.114572*r - 0.385428*g + 0.5*b
///   Cr =  0.5*r - 0.454153*g - 0.045847*b
///
/// Graticule angle convention:
///   0° = +Cb axis, CCW towards +Cr (standard broadcast vectorscope graticule).
///
/// Skin-tone reference line:
///   123.0° (traditional video-colorist heuristic line; target wedge ±10.0°).
///   Reported as a skin locus only when an explicit skin target or skin mask is evaluated.
public enum AgentVectorscope {
  public static let skinToneLineAngleDeg: Double = 123.0
  public static let skinToneLineWedgeDeg: Double = 10.0
  public static let minSampleCountForEvidence = 50

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

  /// Rec.709 chroma coordinates for display-referred sRGB channels (0…1).
  public static func chromaRec709(r: Double, g: Double, b: Double) -> (cb: Double, cr: Double) {
    (
      -0.114572 * r - 0.385428 * g + 0.5 * b,
      0.5 * r - 0.454153 * g - 0.045847 * b
    )
  }

  /// Evaluates chroma distribution on an sRGB RGBA8 buffer with optional mask weights.
  public static func compute(
    rgba: [UInt8],
    width: Int,
    height: Int,
    maskWeights: [UInt8]? = nil,
    hasSkinTarget: Bool,
    maskId: String? = nil
  ) -> Result {
    let count = width * height
    guard count > 0, rgba.count >= count * 4 else {
      return Result(
        basis: "Rec.709 display-referred sRGB",
        convention: "0deg = +Cb, CCW towards +Cr",
        targetHintDeg: skinToneLineAngleDeg,
        targetWedgeDeg: skinToneLineWedgeDeg,
        hasSkinTarget: hasSkinTarget,
        maskId: maskId,
        sampleCount: 0,
        insufficientEvidence: true,
        skinLocusAngleDeg: nil,
        deviationDeg: nil,
        meanCb: 0,
        meanCr: 0,
        confidence: "none",
        warning: "Empty pixel buffer."
      )
    }

    var sumCb = 0.0
    var sumCr = 0.0
    var sumWeight = 0.0
    var sumUnitX = 0.0
    var sumUnitY = 0.0
    var sampleCount = 0

    let weightsCount = maskWeights?.count ?? 0
    let hasWeights = weightsCount >= count

    for index in 0..<count {
      let weight: Double
      if hasWeights {
        let w = maskWeights![index]
        if w < 12 { continue }  // Ignore weights below 5%
        weight = Double(w) / 255.0
      } else {
        weight = 1.0
      }

      let r = Double(rgba[index * 4]) / 255.0
      let g = Double(rgba[index * 4 + 1]) / 255.0
      let b = Double(rgba[index * 4 + 2]) / 255.0

      let (cb, cr) = chromaRec709(r: r, g: g, b: b)
      let mag = (cb * cb + cr * cr).squareRoot()

      // Discard near-achromatic pixels (noise threshold)
      if mag < 0.008 { continue }

      sampleCount += 1
      sumWeight += weight
      sumCb += cb * weight
      sumCr += cr * weight

      sumUnitX += (cb / mag) * weight
      sumUnitY += (cr / mag) * weight
    }

    let meanCb = sumWeight > 0 ? (sumCb / sumWeight * 10_000).rounded() / 10_000 : 0
    let meanCr = sumWeight > 0 ? (sumCr / sumWeight * 10_000).rounded() / 10_000 : 0

    let insufficient = sampleCount < minSampleCountForEvidence || sumWeight <= 0

    if insufficient {
      let warningText =
        sampleCount == 0
        ? "No chromatic samples found."
        : "Fewer than \(minSampleCountForEvidence) chromatic samples (\(sampleCount)). Insufficient evidence to establish a reliable chroma locus."
      return Result(
        basis: "Rec.709 display-referred sRGB",
        convention: "0deg = +Cb, CCW towards +Cr",
        targetHintDeg: skinToneLineAngleDeg,
        targetWedgeDeg: skinToneLineWedgeDeg,
        hasSkinTarget: hasSkinTarget,
        maskId: maskId,
        sampleCount: sampleCount,
        insufficientEvidence: true,
        skinLocusAngleDeg: nil,
        deviationDeg: nil,
        meanCb: meanCb,
        meanCr: meanCr,
        confidence: "insufficient",
        warning: warningText
      )
    }

    var angleDeg = atan2(sumUnitY, sumUnitX) * 180.0 / .pi
    if angleDeg < 0 { angleDeg += 360.0 }
    let roundedAngle = (angleDeg * 10.0).rounded() / 10.0

    let rLength = ((sumUnitX * sumUnitX + sumUnitY * sumUnitY).squareRoot()) / sumWeight
    let confidence: String
    if sampleCount >= 200 && rLength >= 0.5 {
      confidence = "high"
    } else if sampleCount >= 100 {
      confidence = "moderate"
    } else {
      confidence = "low"
    }

    if !hasSkinTarget {
      return Result(
        basis: "Rec.709 display-referred sRGB",
        convention: "0deg = +Cb, CCW towards +Cr",
        targetHintDeg: skinToneLineAngleDeg,
        targetWedgeDeg: skinToneLineWedgeDeg,
        hasSkinTarget: false,
        maskId: maskId,
        sampleCount: sampleCount,
        insufficientEvidence: false,
        skinLocusAngleDeg: nil,
        deviationDeg: nil,
        meanCb: meanCb,
        meanCr: meanCr,
        confidence: confidence,
        warning:
          "Whole-image vectorscope without a skin mask cannot reliably isolate skin from similarly colored surfaces (wood, sand, walls). Create or select a skin mask to evaluate skin locus."
      )
    }

    var dev = roundedAngle - skinToneLineAngleDeg
    while dev > 180 { dev -= 360 }
    while dev < -180 { dev += 360 }
    let roundedDev = (dev * 10.0).rounded() / 10.0

    return Result(
      basis: "Rec.709 display-referred sRGB",
      convention: "0deg = +Cb, CCW towards +Cr",
      targetHintDeg: skinToneLineAngleDeg,
      targetWedgeDeg: skinToneLineWedgeDeg,
      hasSkinTarget: true,
      maskId: maskId,
      sampleCount: sampleCount,
      insufficientEvidence: false,
      skinLocusAngleDeg: roundedAngle,
      deviationDeg: roundedDev,
      meanCb: meanCb,
      meanCr: meanCr,
      confidence: confidence,
      warning: nil
    )
  }

  /// Extracts rendered pixels and optional mask raster to evaluate vectorscope metrics.
  static func evaluate(
    canvasCiImage: CIImage,
    maskCoverageCgImage: CGImage?,
    region: AgentInspector.Region?,
    hasSkinTarget: Bool,
    maskId: String?,
    context: CIContext
  ) throws -> Result {
    let extent = canvasCiImage.extent.integral
    guard extent.width >= 1, extent.height >= 1, extent.width.isFinite else {
      throw AgentError(code: "render_unavailable", message: "The current render is empty.")
    }

    var cropped = canvasCiImage
    if let region {
      let rect = CGRect(
        x: extent.minX + region.x * extent.width,
        y: extent.maxY - (region.y + region.height) * extent.height,
        width: region.width * extent.width,
        height: region.height * extent.height
      ).integral.intersection(extent)
      cropped = canvasCiImage.cropped(to: rect)
    }

    let source = cropped.extent
    let maxEdge = 512
    let scale = min(1, Double(maxEdge) / Double(max(source.width, source.height)))
    let width = max(1, Int((source.width * scale).rounded()))
    let height = max(1, Int((source.height * scale).rounded()))

    let scaled =
      cropped
      .transformed(by: CGAffineTransform(translationX: -source.minX, y: -source.minY))
      .transformed(
        by: CGAffineTransform(
          scaleX: CGFloat(width) / source.width, y: CGFloat(height) / source.height))

    guard let sRGB = CGColorSpace(name: CGColorSpace.sRGB),
      let cgImage = context.createCGImage(
        scaled, from: CGRect(x: 0, y: 0, width: width, height: height), format: .RGBA8,
        colorSpace: sRGB)
    else {
      throw AgentError(code: "render_unavailable", message: "Could not rasterize the render.")
    }

    let rgba = try AgentInspector.rgbaBytes(cgImage, colorSpace: sRGB)

    var maskWeights: [UInt8]?
    if let maskCoverageCgImage {
      maskWeights = extractMaskWeights(maskCoverageCgImage, width: width, height: height)
    }

    return compute(
      rgba: rgba,
      width: width,
      height: height,
      maskWeights: maskWeights,
      hasSkinTarget: hasSkinTarget,
      maskId: maskId
    )
  }

  /// Extracts 8-bit alpha/weight bytes rescaled to target dimensions.
  static func extractMaskWeights(_ maskImage: CGImage, width: Int, height: Int) -> [UInt8]? {
    var bytes = [UInt8](repeating: 0, count: width * height)
    let colorSpace = CGColorSpaceCreateDeviceGray()
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard
        let ctx = CGContext(
          data: buffer.baseAddress,
          width: width,
          height: height,
          bitsPerComponent: 8,
          bytesPerRow: width,
          space: colorSpace,
          bitmapInfo: CGImageAlphaInfo.none.rawValue
        )
      else { return false }
      ctx.interpolationQuality = .high
      ctx.draw(maskImage, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    return drawn ? bytes : nil
  }
}
