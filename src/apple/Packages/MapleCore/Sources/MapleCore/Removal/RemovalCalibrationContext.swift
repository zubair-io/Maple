// Bounded canonical calibration experiment (#3955); no authoring UI is enabled.
import Foundation
import RawPipeline

extension RemovalBridge {
  /// One gesture batch, oriented post-perspective PRE-user-crop UV -> native
  /// pre-lens DefaultCrop UV. Optional crop_input_size supplies actual pre-crop
  /// buffer dimensions for cropped output UV; otherwise undo crop presentation.
  /// JSON null must break a stroke across the surround, not become edge paint.
  /// Metadata only: no model inference, RAW decode or image allocation (#3934).
  public static func mapDisplayPoints(handle: MapleRawHandle, xmp: String, request: String) throws
    -> String
  {
    guard !xmp.utf8.contains(0), !request.utf8.contains(0) else {
      throw RemovalError.invalid("Removal geometry request contains NUL")
    }
    let data = try withExtendedLifetime(handle) {
      try xmp.withCString { xmp in
        try request.withCString { request in
          try buffer { output, cap, length in
            maple_removal_map_points_buf(handle.pointer, xmp, request, output, cap, length)
          }
        }
      }
    }
    return String(decoding: data, as: UTF8.self)
  }

  /// Shared source-anchor JSON from original bytes captured at handle open and
  /// the fixed calibration recipe. Read once when opening removal authoring.
  public static func calibrationSource(handle: MapleRawHandle) throws -> String {
    let data = try withExtendedLifetime(handle) {
      try buffer { output, cap, length in
        maple_removal_calibration_source_buf(handle.pointer, output, cap, length)
      }
    }
    return String(decoding: data, as: UTF8.self)
  }

  /// Interleaved scene-linear Rec.2020 RGB before creative WB and DCP HSM.
  /// Coordinates are native, unoriented DefaultCrop pixels. Run off the main
  /// actor: this synchronous call reuses the retained mosaic and demosaics the
  /// bounded region. It does not allocate a whole-image RGB plate.
  public static func calibrationContext(
    handle: MapleRawHandle, x: UInt32, y: UInt32, width: UInt32, height: UInt32,
    cancel: CancelFlag? = nil
  ) throws -> [Float] {
    // Reject before allocating; the shared core validates source bounds and
    // supported mosaics. The 1024 cap matches this experiment's model context.
    guard width > 0, height > 0, width <= 1024, height <= 1024 else {
      throw RemovalError.invalid("Invalid removal calibration context extent")
    }
    let count = Int(width) * Int(height) * 3
    var output = [Float](repeating: 0, count: count)
    var length: UInt = 0
    let rc = withExtendedLifetime((handle, cancel)) {
      output.withUnsafeMutableBufferPointer { buffer in
        maple_removal_calibration_context_f32(
          handle.pointer, x, y, width, height, cancel?.pointer, buffer.baseAddress,
          UInt(buffer.count), &length)
      }
    }
    if rc == 20 { throw PipelineError.cancelled }
    guard rc == 0, length == UInt(count) else {
      throw RemovalError.invalid("Removal calibration context failed (\(rc))")
    }
    return output
  }
}
