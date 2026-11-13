import Foundation

/// The JPEG Exif block, found by walking segment headers up to the start of scan.
enum LiveJpeg {
  private static let exifSignature: [UInt8] = Array("Exif\0\0".utf8)
  private static let maxSegments = 256
  private static let app1: UInt8 = 0xe1
  private static let startOfScan: UInt8 = 0xda
  private static let endOfImage: UInt8 = 0xd9

  /// The TIFF-structured Exif block: the payload after `Exif\0\0` of the first APP1 segment that
  /// starts with it. Only headers and that one segment are read, never the entropy-coded image
  /// data, and an APP1 payload is at most 64 KB by construction.
  static func exifBlock(_ source: LiveByteSource) async -> [UInt8]? {
    var offset: UInt64 = 2
    for _ in 0..<maxSegments {
      guard let head = await source.read(offset, 2), head[0] == 0xff else { return nil }
      let marker = head[1]
      if marker == 0xff {
        offset += 1
        continue
      }
      if marker == startOfScan || marker == endOfImage { return nil }
      if marker == 0x01 || (0xd0...0xd7).contains(marker) {
        offset += 2
        continue
      }
      guard let lengthBytes = await source.read(offset + 2, 2),
        let segmentLength = LiveBinary.int(lengthBytes, 0, 2), segmentLength >= 2
      else { return nil }
      if marker == app1, let payload = await exifPayload(source, offset + 4, segmentLength - 2) {
        return payload
      }
      offset += 2 + UInt64(segmentLength)
    }
    return nil
  }

  private static func exifPayload(_ source: LiveByteSource, _ start: UInt64, _ length: Int) async
    -> [UInt8]?
  {
    guard length > exifSignature.count,
      await source.read(start, exifSignature.count) == exifSignature
    else { return nil }
    return await source.read(start + UInt64(exifSignature.count), length - exifSignature.count)
  }
}
