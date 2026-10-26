import CoreGraphics
import CoreImage
import Foundation
import RawPipeline

enum PersonSkinRangeInitializer {
  static func initialRange(
    decoded: ImageEditPipeline.SceneLinearDecodeResult,
    model: AdjustmentModel,
    asShot: ImageEditPipeline.AsShotWB?,
    maskWidth: Int,
    maskHeight: Int,
    maskBytes: [UInt8],
    faceSkinMaskBytes: [UInt8]
  ) -> RangeRefinement {
    guard
      let decodedBytes = makeDecodedRec2020Bytes(
        decoded: decoded,
        width: maskWidth,
        height: maskHeight
      ),
      let sample = adaptiveSampleIfDefaultInert(
        decodedRec2020RGBAf: decodedBytes,
        decoded: decoded,
        model: model,
        asShot: asShot,
        maskWidth: maskWidth,
        maskHeight: maskHeight,
        maskBytes: maskBytes,
        faceSkinMaskBytes: faceSkinMaskBytes
      )
    else {
      return .skinTone
    }
    return RangeRefinement.skinTone.seeded(with: sample)
  }

  static func makeDecodedRec2020Bytes(
    decoded: ImageEditPipeline.SceneLinearDecodeResult,
    width: Int,
    height: Int
  ) -> Data? {
    guard width > 0, height > 0,
      let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)
    else {
      return nil
    }
    let srcExtent = decoded.image.extent
    guard srcExtent.width > 0, srcExtent.height > 0 else { return nil }
    let sx = CGFloat(width) / srcExtent.width
    let sy = CGFloat(height) / srcExtent.height
    let scaled = decoded.image
      .transformed(by: CGAffineTransform(translationX: -srcExtent.origin.x, y: -srcExtent.origin.y))
      .transformed(by: CGAffineTransform(scaleX: sx, y: sy))

    let rowBytes = width * 16
    var inputBytes = Data(count: rowBytes * height)
    let context = CIContext(options: [.workingColorSpace: space, .outputColorSpace: space])
    let rendered = inputBytes.withUnsafeMutableBytes { buf -> Bool in
      guard let base = buf.baseAddress else { return false }
      context.render(
        scaled,
        toBitmap: base,
        rowBytes: rowBytes,
        bounds: CGRect(x: 0, y: 0, width: width, height: height),
        format: .RGBAf,
        colorSpace: space
      )
      return true
    }
    return rendered ? inputBytes : nil
  }

  static func adaptiveSampleIfDefaultInert(
    decodedRec2020RGBAf: Data,
    decoded: ImageEditPipeline.SceneLinearDecodeResult,
    model: AdjustmentModel,
    asShot: ImageEditPipeline.AsShotWB?,
    maskWidth: Int,
    maskHeight: Int,
    maskBytes: [UInt8],
    faceSkinMaskBytes: [UInt8]
  ) -> MaskRangeSample? {
    let pixelCount = maskWidth * maskHeight
    guard maskWidth > 0, maskHeight > 0,
      maskBytes.count == pixelCount,
      faceSkinMaskBytes.count == pixelCount,
      decodedRec2020RGBAf.count == pixelCount * 16
    else {
      return nil
    }
    let params = PipelineRenderer.makeParams(
      from: model,
      decodedTemperature: asShot?.temperature ?? 6500.0,
      decodedTint: asShot?.tint ?? 0.0,
      skipAgX: true,
      iso: decoded.iso,
      wbFrame: decoded.wbFrame,
      whitesAnchorEv: decoded.whitesAnchorEv,
      nrSamplingScale: decoded.nrSamplingScale
    )
    let curves = PipelineRenderer.ChainToneCurves(model: model)
    var output = MapleRangeSeed()
    let code = PipelineRenderer.withChainPointers(
      params,
      noiseProfile: decoded.noiseProfile,
      localAdjustments: []
    ) { bound in
      var p = bound
      return curves.withMapleToneCurves { curvesPtr in
        decodedRec2020RGBAf.withUnsafeBytes { rawBuffer -> Int32 in
          guard let floats = rawBuffer.bindMemory(to: Float.self).baseAddress else { return 2 }
          return maskBytes.withUnsafeBufferPointer { maskPtr -> Int32 in
            guard let maskBase = maskPtr.baseAddress else { return 2 }
            return faceSkinMaskBytes.withUnsafeBufferPointer { facePtr -> Int32 in
              guard let faceBase = facePtr.baseAddress else { return 2 }
              return maple_seed_skin_mask_range_if_default_inert(
                floats,
                UInt(maskWidth),
                UInt(maskHeight),
                &p,
                curvesPtr,
                maskBase,
                UInt(maskBytes.count),
                faceBase,
                UInt(faceSkinMaskBytes.count),
                &output
              )
            }
          }
        }
      }
    }
    guard code == 0 else { return nil }
    return MaskRangeSample(
      hueDeg: Double(output.hue_deg),
      chromaMin: Double(output.chroma_min),
      lMin: Double(output.l_min),
      lMax: Double(output.l_max)
    )
  }

  static func adaptiveSampleIfDefaultInert(
    stageInputRec2020RGBAf: Data,
    maskWidth: Int,
    maskHeight: Int,
    maskBytes: [UInt8],
    faceSkinMaskBytes: [UInt8]? = nil
  ) -> MaskRangeSample? {
    let faceMask = faceSkinMaskBytes ?? maskBytes
    let pixelCount = maskWidth * maskHeight
    guard maskWidth > 0, maskHeight > 0,
      maskBytes.count == pixelCount,
      faceMask.count == pixelCount,
      stageInputRec2020RGBAf.count == pixelCount * 16
    else {
      return nil
    }
    var output = MapleRangeSeed()
    let code = stageInputRec2020RGBAf.withUnsafeBytes { rawBuffer -> Int32 in
      guard let floats = rawBuffer.bindMemory(to: Float.self).baseAddress else { return 2 }
      return maskBytes.withUnsafeBufferPointer { maskPtr -> Int32 in
        guard let maskBase = maskPtr.baseAddress else { return 2 }
        return faceMask.withUnsafeBufferPointer { facePtr -> Int32 in
          guard let faceBase = facePtr.baseAddress else { return 2 }
          return maple_seed_skin_mask_range_if_default_inert(
            floats,
            UInt(maskWidth),
            UInt(maskHeight),
            nil,
            nil,
            maskBase,
            UInt(maskBytes.count),
            faceBase,
            UInt(faceMask.count),
            &output
          )
        }
      }
    }
    guard code == 0 else { return nil }
    return MaskRangeSample(
      hueDeg: Double(output.hue_deg),
      chromaMin: Double(output.chroma_min),
      lMin: Double(output.l_min),
      lMax: Double(output.l_max)
    )
  }
}
