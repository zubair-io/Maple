import Foundation

/// Display-referred selection inputs only. Reconstruction always consumes the
/// shared native f32 calibration context. No host color transform is applied.
struct NativeRemovalProxyTensors: Sendable {
  let inputWidth: UInt32
  let inputHeight: UInt32
  let encoder: [Float]
  let detector: [Float]

  init(_ proxy: NativeRemovalRender, width: UInt32, height: UInt32) throws {
    guard width > 0, height > 0, proxy.width > 0, proxy.height > 0,
      proxy.bytes.count == Int(proxy.width) * Int(proxy.height) * 3
    else { throw RemovalError.invalid("Invalid photographic selection proxy") }
    let side = ExperimentalRemovalModels.encoder.nativeSide
    let longest = max(width, height)
    let scaled = { (extent: UInt32) in
      longest <= side
        ? extent
        : max(1, UInt32((UInt64(extent) * UInt64(side) + UInt64(longest) / 2) / UInt64(longest)))
    }
    inputWidth = scaled(width)
    inputHeight = scaled(height)
    encoder = Self.tensor(
      proxy, side: Int(side), width: Int(inputWidth), height: Int(inputHeight), scale: 1)
    let detectorSide = Int(ExperimentalRemovalModels.detector.nativeSide)
    detector = Self.tensor(
      proxy, side: detectorSide, width: detectorSide, height: detectorSide, scale: 255)
  }

  private static func tensor(
    _ proxy: NativeRemovalRender, side: Int, width: Int, height: Int, scale: Float
  ) -> [Float] {
    let plane = side * side
    var output = [Float](repeating: 0, count: 3 * plane)
    let sourceWidth = Int(proxy.width)
    let sourceHeight = Int(proxy.height)
    proxy.bytes.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
      for y in 0..<height {
        let sy = min(
          Double(sourceHeight - 1),
          max(0, (Double(y) + 0.5) * Double(sourceHeight) / Double(height) - 0.5))
        let y0 = Int(sy)
        let y1 = min(sourceHeight - 1, y0 + 1)
        let dy = sy - Double(y0)
        for x in 0..<width {
          let sx = min(
            Double(sourceWidth - 1),
            max(0, (Double(x) + 0.5) * Double(sourceWidth) / Double(width) - 0.5))
          let x0 = Int(sx)
          let x1 = min(sourceWidth - 1, x0 + 1)
          let dx = sx - Double(x0)
          for channel in 0..<3 {
            let sample = { (x: Int, y: Int) in Double(bytes[(y * sourceWidth + x) * 3 + channel]) }
            let top = sample(x0, y0) * (1 - dx) + sample(x1, y0) * dx
            let bottom = sample(x0, y1) * (1 - dx) + sample(x1, y1) * dx
            output[channel * plane + y * side + x] =
              Float((top * (1 - dy) + bottom * dy).rounded()) / scale
          }
        }
      }
    }
    return output
  }
}
