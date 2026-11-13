// Shared RAW metadata fallback for canvas layout (#3984).
import Foundation
import RawPipeline

/// Only used on cold open when the platform reader cannot read the RAW.
/// Never infer native dimensions from a viewport-sized decoded image.
enum RawDimensions {
  static func read(from url: URL) -> ImageMetadataReader.PixelSize? {
    var width: UInt32 = 0
    var height: UInt32 = 0
    let rc = url.path.withCString { maple_raw_dimensions_file($0, &width, &height) }
    guard rc == 0, width > 0, height > 0 else { return nil }
    return ImageMetadataReader.PixelSize(width: Double(width), height: Double(height))
  }

  static func read(from data: Data, hint: String?) -> ImageMetadataReader.PixelSize? {
    guard !(hint ?? "").utf8.contains(0) else { return nil }
    var width: UInt32 = 0
    var height: UInt32 = 0
    let rc = data.withUnsafeBytes { bytes in
      (hint ?? "").withCString {
        maple_raw_dimensions_bytes(
          bytes.bindMemory(to: UInt8.self).baseAddress, UInt(bytes.count), $0, &width, &height)
      }
    }
    guard rc == 0, width > 0, height > 0 else { return nil }
    return ImageMetadataReader.PixelSize(width: Double(width), height: Double(height))
  }
}
