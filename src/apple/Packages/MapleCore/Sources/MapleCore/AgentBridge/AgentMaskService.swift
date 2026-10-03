import CoreGraphics
import CoreImage
import Foundation
import MapleAgentWire

@MainActor
public enum AgentMaskService {
  public struct CompositeResult: Sendable {
    public let jpeg: Data
    public let width: Int
    public let height: Int
    public let coveragePct: Double
    public let sampleCount: Int
  }

  public static func createMask(
    _ arguments: [String: JSONValue],
    in session: EditSession
  ) async throws -> JSONValue {
    guard let kind = arguments["kind"]?.stringValue else {
      throw AgentError(
        code: "invalid_arguments",
        message: "`kind` is required (linear, radial, person_skin, whole_image_skin)."
      )
    }

    let params = arguments["params"]?.objectValue ?? [:]
    let label = arguments["description"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }

    switch kind {
    case "linear":
      let startX = params["start"]?["x"]?.numberValue ?? 0.5
      let startY = params["start"]?["y"]?.numberValue ?? 0.15
      let endX = params["end"]?["x"]?.numberValue ?? 0.5
      let endY = params["end"]?["y"]?.numberValue ?? 0.55
      let feather = params["feather"]?.numberValue ?? 0.5

      guard (0...1).contains(startX), (0...1).contains(startY),
        (0...1).contains(endX), (0...1).contains(endY),
        (0...1).contains(feather)
      else {
        throw AgentError(
          code: "invalid_arguments",
          message: "Linear mask coordinates and feather must be normalized in 0…1."
        )
      }

      session.beginEdit(kind: .mask, description: "AI: \(label ?? "Add linear mask")")
      let mask = LocalMask.linear(
        start: MaskPoint(x: startX, y: startY),
        end: MaskPoint(x: endX, y: endY),
        feather: feather
      )
      let layer = LocalAdjustment(mask: mask, adjustments: PartialAdjustments())
      session.model.localAdjustments.append(layer)
      session.selectedMaskId = layer.id
      session.endEdit()

      var result = AgentEditService.summaryFields(session)
      result["mask_id"] = .string(layer.id.uuidString)
      result["kind"] = .string("linear")
      return .object(result)

    case "radial":
      let centerX = params["center"]?["x"]?.numberValue ?? 0.5
      let centerY = params["center"]?["y"]?.numberValue ?? 0.5
      let radiusX = params["radii"]?["x"]?.numberValue ?? 0.25
      let radiusY = params["radii"]?["y"]?.numberValue ?? 0.25
      let angle = params["angle"]?.numberValue ?? 0.0
      let feather = params["feather"]?.numberValue ?? 0.5
      let invert = params["invert"]?.boolValue ?? false

      guard (0...1).contains(centerX), (0...1).contains(centerY),
        radiusX > 0, radiusY > 0,
        (0...1).contains(feather)
      else {
        throw AgentError(
          code: "invalid_arguments",
          message: "Radial mask center and radii must be positive normalized numbers in 0…1."
        )
      }

      session.beginEdit(kind: .mask, description: "AI: \(label ?? "Add radial mask")")
      let mask = LocalMask.radial(
        center: MaskPoint(x: centerX, y: centerY),
        radii: MaskPoint(x: radiusX, y: radiusY),
        angle: angle,
        feather: feather,
        invert: invert
      )
      let layer = LocalAdjustment(mask: mask, adjustments: PartialAdjustments())
      session.model.localAdjustments.append(layer)
      session.selectedMaskId = layer.id
      session.endEdit()

      var result = AgentEditService.summaryFields(session)
      result["mask_id"] = .string(layer.id.uuidString)
      result["kind"] = .string("radial")
      return .object(result)

    case "person_skin":
      let candidates: [PersonCandidate]
      do {
        candidates = try await session.detectMaskPersons()
      } catch PersonSkinMaskError.noPersonDetected {
        throw AgentError(
          code: "no_person_detected",
          message:
            "No person was detected in this photo. You can use kind \"whole_image_skin\" or \"radial\" instead."
        )
      } catch {
        throw AgentError(code: "vision_failed", message: error.localizedDescription)
      }

      guard !candidates.isEmpty else {
        throw AgentError(
          code: "no_person_detected",
          message:
            "No person was detected in this photo. You can use kind \"whole_image_skin\" or \"radial\" instead."
        )
      }

      let personIndex = Int(params["person_index"]?.numberValue ?? 0)
      guard candidates.indices.contains(personIndex) else {
        throw AgentError(
          code: "invalid_arguments",
          message:
            "person_index \(personIndex) is out of range. Detected \(candidates.count) person(s) (indices 0..<\(candidates.count))."
        )
      }

      let facialSkin = params["facial_skin"]?.boolValue ?? true
      let bodySkin = params["body_skin"]?.boolValue ?? true

      session.beginEdit(kind: .mask, description: "AI: \(label ?? "Add person skin mask")")
      do {
        try await session.createPersonSkinMask(
          person: candidates[personIndex],
          facialSkin: facialSkin,
          bodySkin: bodySkin
        )
      } catch {
        session.endEdit()
        throw AgentError(code: "vision_failed", message: error.localizedDescription)
      }
      session.endEdit()

      guard let layerId = session.selectedMaskId else {
        throw AgentError(code: "internal", message: "Failed to select created mask.")
      }

      var result = AgentEditService.summaryFields(session)
      result["mask_id"] = .string(layerId.uuidString)
      result["kind"] = .string("person_skin")
      return .object(result)

    case "whole_image_skin":
      session.beginEdit(kind: .mask, description: "AI: \(label ?? "Add skin range mask")")
      session.createWholeImageSkinMask()
      session.endEdit()

      guard let layerId = session.selectedMaskId else {
        throw AgentError(code: "internal", message: "Failed to select created mask.")
      }

      var result = AgentEditService.summaryFields(session)
      result["mask_id"] = .string(layerId.uuidString)
      result["kind"] = .string("whole_image_skin")
      return .object(result)

    default:
      throw AgentError(
        code: "invalid_arguments",
        message:
          "Unknown mask kind `\(kind)`. Valid kinds: linear, radial, person_skin, whole_image_skin."
      )
    }
  }

  public static func renderMaskOverlay(
    _ arguments: [String: JSONValue],
    in session: EditSession
  ) async throws -> AgentPayload {
    let maxEdge = try AgentInspector.parseMaxEdge(arguments["max_edge"])
    let targetLayer: LocalAdjustment
    if let maskIdStr = arguments["mask_id"]?.stringValue {
      guard let uuid = UUID(uuidString: maskIdStr),
        let layer = session.model.localAdjustments.first(where: { $0.id == uuid })
      else {
        throw AgentError(code: "mask_not_found", message: "No mask found with ID `\(maskIdStr)`.")
      }
      targetLayer = layer
    } else if let selectedId = session.selectedMaskId,
      let layer = session.model.localAdjustments.first(where: { $0.id == selectedId })
    {
      targetLayer = layer
    } else {
      throw AgentError(
        code: "no_mask_selected",
        message: "No mask is selected and no `mask_id` was provided."
      )
    }

    guard let canvasCiImage = await session.agentCanvasSnapshot() else {
      throw AgentError(
        code: "render_unavailable",
        message: "Maple hasn't finished rendering this photo yet. Retry in a moment."
      )
    }

    let maskCoverageCgImage = await session.maskCoveragePreview(for: targetLayer.mask)

    let context = session.pipeline.context
    let rendered = try await Task.detached(priority: .userInitiated) {
      try compositeOverlay(
        canvasCiImage: canvasCiImage,
        maskCoverageCgImage: maskCoverageCgImage,
        targetLayer: targetLayer,
        maxEdge: maxEdge,
        context: context
      )
    }.value

    var result = AgentEditService.summaryFields(session)
    result["mask_id"] = .string(targetLayer.id.uuidString)
    result["kind"] = .string(targetLayer.kindName)
    result["coverage_pct"] = .number(rendered.coveragePct)
    result["sample_count"] = .int(rendered.sampleCount)
    result["width"] = .int(rendered.width)
    result["height"] = .int(rendered.height)

    return AgentPayload(
      result: .object(result),
      image: AgentImage(data: rendered.jpeg, mimeType: "image/jpeg")
    )
  }

  /// Composites a translucent red overlay over the canvas snapshot.
  nonisolated static func compositeOverlay(
    canvasCiImage: CIImage,
    maskCoverageCgImage: CGImage?,
    targetLayer: LocalAdjustment,
    maxEdge: Int,
    context: CIContext
  ) throws -> CompositeResult {
    let extent = canvasCiImage.extent.integral
    guard extent.width >= 1, extent.height >= 1, extent.width.isFinite else {
      throw AgentError(code: "render_unavailable", message: "The current render is empty.")
    }

    let scale = min(1, Double(maxEdge) / Double(max(extent.width, extent.height)))
    let width = max(1, Int((extent.width * scale).rounded()))
    let height = max(1, Int((extent.height * scale).rounded()))

    let scaled =
      canvasCiImage
      .transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
      .transformed(
        by: CGAffineTransform(
          scaleX: CGFloat(width) / extent.width, y: CGFloat(height) / extent.height))

    guard let sRGB = CGColorSpace(name: CGColorSpace.sRGB),
      let cgImage = context.createCGImage(
        scaled, from: CGRect(x: 0, y: 0, width: width, height: height), format: .RGBA8,
        colorSpace: sRGB)
    else {
      throw AgentError(code: "render_unavailable", message: "Could not rasterize the render.")
    }

    var pixels = try AgentInspector.rgbaBytes(cgImage, colorSpace: sRGB)
    let count = width * height

    let weights: [UInt8]
    if let maskCoverageCgImage {
      weights =
        AgentVectorscope.extractMaskWeights(maskCoverageCgImage, width: width, height: height)
        ?? [UInt8](repeating: 0, count: count)
    } else if targetLayer.mask == .everywhere {
      weights = [UInt8](repeating: 255, count: count)
    } else {
      weights = [UInt8](repeating: 0, count: count)
    }

    var nonZeroCount = 0
    for i in 0..<count {
      let w = weights[i]
      if w >= 12 { nonZeroCount += 1 }
      guard w > 0 else { continue }
      let alpha = Double(w) / 255.0 * 0.45  // 45% red opacity
      let r = Double(pixels[i * 4])
      let g = Double(pixels[i * 4 + 1])
      let b = Double(pixels[i * 4 + 2])

      pixels[i * 4] = UInt8(min(255, max(0, Int((r * (1.0 - alpha) + 255.0 * alpha).rounded()))))
      pixels[i * 4 + 1] = UInt8(min(255, max(0, Int((g * (1.0 - alpha)).rounded()))))
      pixels[i * 4 + 2] = UInt8(min(255, max(0, Int((b * (1.0 - alpha)).rounded()))))
    }

    let coveragePct =
      count > 0 ? (Double(nonZeroCount) / Double(count) * 1000.0).rounded() / 10.0 : 0.0

    let provider = CGDataProvider(data: Data(pixels) as CFData)!
    guard
      let blendedImage = CGImage(
        width: width,
        height: height,
        bitsPerComponent: 8,
        bitsPerPixel: 32,
        bytesPerRow: width * 4,
        space: sRGB,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
        provider: provider,
        decode: nil,
        shouldInterpolate: true,
        intent: .defaultIntent
      )
    else {
      throw AgentError(code: "render_unavailable", message: "Failed to create overlay image.")
    }

    let jpeg = try AgentInspector.jpeg(blendedImage)
    return CompositeResult(
      jpeg: jpeg,
      width: width,
      height: height,
      coveragePct: coveragePct,
      sampleCount: nonZeroCount
    )
  }
}

extension LocalAdjustment {
  public var kindName: String {
    switch mask {
    case .linear: return "linear"
    case .radial: return "radial"
    case .bitmap(let recipe, _):
      if recipe.model.contains("person") { return "person_skin" }
      return "bitmap"
    case .everywhere:
      if range == .skinTone { return "whole_image_skin" }
      return "everywhere"
    case .group: return "group"
    }
  }
}
