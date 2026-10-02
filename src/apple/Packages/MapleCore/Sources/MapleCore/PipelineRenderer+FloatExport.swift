import CoreImage
import Foundation
import RawPipeline

extension PipelineRenderer {
  /// The complete shared full-size RAW display chain, kept at float precision
  /// for PNG/JPEG/HEIF and 16-bit TIFF encoders (#1472). Geometry is complete.
  public static func renderFullDisplay(
    rawPath: URL, xmpPath: URL?, quality: Quality, target: CanvasColorSpace,
    filmLut: (data: [Float], size: Int, key: UInt32)? = nil
  ) throws -> CIImage {
    guard !rawPath.path.utf8.contains(0) else { throw PipelineError.pathEncodingError(rawPath) }
    if let xmpPath, xmpPath.path.utf8.contains(0) {
      throw PipelineError.pathEncodingError(xmpPath)
    }
    var buffer = MapleDisplayBufferF32()
    let render: (UnsafePointer<CChar>?) -> Int32 = { xmp in
      rawPath.path.withCString { raw in
        if let filmLut {
          guard let size = UInt32(exactly: filmLut.size) else { return 10 }
          return filmLut.data.withUnsafeBufferPointer {
            maple_render_file_display_f32(
              raw, xmp, quality.rawValue, target.wireValue,
              $0.baseAddress, UInt($0.count), size, &buffer)
          }
        }
        return maple_render_file_display_f32(
          raw, xmp, quality.rawValue, target.wireValue, nil, 0, 0, &buffer)
      }
    }
    let rc = xmpPath.map { $0.path.withCString(render) } ?? render(nil)
    guard rc == 0 else {
      maple_free_display_buffer_f32(&buffer)
      let message = maple_last_error().map { String(cString: $0) } ?? "Full RAW export failed"
      throw PipelineError.renderFailed(code: Int(rc), message: message)
    }
    let width = Int(buffer.width)
    let height = Int(buffer.height)
    guard let pointer = buffer.rgba, width > 0, height > 0,
      Int(buffer.len) == width * height * 4
    else {
      maple_free_display_buffer_f32(&buffer)
      throw PipelineError.renderFailed(code: 8, message: "Invalid float export extent")
    }
    // Transfer the Rust allocation without an intermediate full-image copy.
    // CoreImage retains its bitmap; release always returns to Rust's allocator.
    let data = Data(
      bytesNoCopy: pointer, count: Int(buffer.len) * MemoryLayout<Float>.size,
      deallocator: .custom { pointer, bytes in
        var owned = MapleDisplayBufferF32(
          rgba: pointer.assumingMemoryBound(to: Float.self),
          len: UInt(bytes / MemoryLayout<Float>.size), width: 0, height: 0)
        maple_free_display_buffer_f32(&owned)
      })
    let space = CGColorSpace(
      name: target == .srgb ? CGColorSpace.extendedSRGB : CGColorSpace.extendedDisplayP3)!
    return CIImage(
      bitmapData: data, bytesPerRow: width * 16, size: CGSize(width: width, height: height),
      format: .RGBAf, colorSpace: space)
  }
}
