// ImageMetadataReader+Tiff.swift — TIFF / DNG direct IFD parser fallback
// and helper methods for ImageMetadataReader.
//
// When Apple's CIRAWFilter and CGImageSource cannot decode or recognize
// dimensions (such as synthetic CFA Bayer DNGs without embedded previews,
// or non-commercial camera profiles), this reader directly inspects the
// standard TIFF IFD structure for ImageWidth (0x0100), ImageLength (0x0101),
// and Orientation (0x0112).

import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers

extension ImageMetadataReader {

  /// Direct TIFF / DNG header parser fallback when ImageIO and CIRAWFilter
  /// cannot discover pixel dimensions.
  public static func readTiffPixelSize(from url: URL) -> PixelSize? {
    guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
      return nil
    }
    return readTiffPixelSize(from: data)
  }

  /// Direct TIFF / DNG byte parser fallback for in-memory buffers.
  public static func readTiffPixelSize(from data: Data) -> PixelSize? {
    guard data.count >= 8 else { return nil }

    let isLittleEndian: Bool
    let b0 = data[data.startIndex]
    let b1 = data[data.startIndex + 1]
    if b0 == 0x49 && b1 == 0x49 {
      isLittleEndian = true
    } else if b0 == 0x4D && b1 == 0x4D {
      isLittleEndian = false
    } else {
      return nil
    }

    func readU16(at offset: Int) -> UInt16? {
      guard offset >= 0, offset + 2 <= data.count else { return nil }
      let idx = data.startIndex + offset
      let byte0 = UInt16(data[idx])
      let byte1 = UInt16(data[idx + 1])
      return isLittleEndian ? (byte0 | (byte1 << 8)) : ((byte0 << 8) | byte1)
    }

    func readU32(at offset: Int) -> UInt32? {
      guard offset >= 0, offset + 4 <= data.count else { return nil }
      let idx = data.startIndex + offset
      let byte0 = UInt32(data[idx])
      let byte1 = UInt32(data[idx + 1])
      let byte2 = UInt32(data[idx + 2])
      let byte3 = UInt32(data[idx + 3])
      return isLittleEndian
        ? (byte0 | (byte1 << 8) | (byte2 << 16) | (byte3 << 24))
        : ((byte0 << 24) | (byte1 << 16) | (byte2 << 8) | byte3)
    }

    guard let magic = readU16(at: 2), magic == 42 else { return nil }
    guard let ifd0Offset = readU32(at: 4) else { return nil }

    var queue: [Int] = [Int(ifd0Offset)]
    var visited = Set<Int>()
    var bestArea: Double = -1
    var bestSize: PixelSize? = nil

    while !queue.isEmpty && visited.count < 32 {
      let offset = queue.removeFirst()
      if visited.contains(offset) || offset <= 0 { continue }
      visited.insert(offset)

      guard let numEntries = readU16(at: offset) else { continue }
      var entryOffset = offset + 2
      var ifdWidth: Double? = nil
      var ifdHeight: Double? = nil
      var ifdOrient: Int? = nil

      for _ in 0..<numEntries {
        guard entryOffset + 12 <= data.count else { break }
        guard let tag = readU16(at: entryOffset),
          let typ = readU16(at: entryOffset + 2),
          let count = readU32(at: entryOffset + 4)
        else { break }

        let valOffset = entryOffset + 8
        func readScalar() -> Double? {
          if typ == 3 {
            return readU16(at: valOffset).map(Double.init)
          } else if typ == 4 {
            return readU32(at: valOffset).map(Double.init)
          }
          return nil
        }

        if tag == 0x0100 {
          ifdWidth = readScalar()
        } else if tag == 0x0101 {
          ifdHeight = readScalar()
        } else if tag == 0x0112 {
          ifdOrient = readU16(at: valOffset).map(Int.init)
        } else if tag == 0x014A {
          if count == 1 {
            if let sub = readU32(at: valOffset), sub > 0 {
              queue.append(Int(sub))
            }
          } else if count > 1 {
            if let arrOff = readU32(at: valOffset) {
              for i in 0..<min(Int(count), 16) {
                if let sub = readU32(at: Int(arrOff) + i * 4), sub > 0 {
                  queue.append(Int(sub))
                }
              }
            }
          }
        }

        entryOffset += 12
      }

      if let nextIfd = readU32(at: entryOffset), nextIfd > 0 {
        queue.append(Int(nextIfd))
      }

      if let w = ifdWidth, let h = ifdHeight, w > 0, h > 0 {
        let oriented = orientedPixelSize(width: w, height: h, orientationValue: ifdOrient)
        let area = oriented.width * oriented.height
        if area > bestArea {
          bestArea = area
          bestSize = oriented
        }
      }
    }

    return bestSize
  }

  /// Walks every subimage in a CGImageSource and returns the orientation-
  /// adjusted size of the largest one. Shared between the URL and Data
  /// readPixelSize variants so the multi-IFD DNG handling is identical.
  static func largestSubimageSize(in src: CGImageSource) -> PixelSize? {
    let count = CGImageSourceGetCount(src)
    var best: (w: Double, h: Double, orient: Int?)? = nil
    for i in 0..<count {
      guard let props = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any],
        let w = number(props[kCGImagePropertyPixelWidth]),
        let h = number(props[kCGImagePropertyPixelHeight])
      else { continue }
      let curArea = best.map { $0.w * $0.h } ?? -1
      if w * h > curArea {
        let o = number(props[kCGImagePropertyOrientation]).map(Int.init)
        best = (w, h, o)
      }
    }
    guard let best else { return nil }
    return orientedPixelSize(width: best.w, height: best.h, orientationValue: best.orient)
  }

  /// Build a CIRAWFilter from raw bytes when the source has no URL.
  /// Returns `nil` for non-RAW data — callers should fall through to the
  /// CGImageSource path. CIRAWFilter requires a Uniform Type Identifier
  /// (e.g. `"com.adobe.raw-image"`) — a bare extension (`"dng"`) makes
  /// it return `nil` and silently fall through to the embedded preview,
  /// which is exactly the bug we're trying to avoid. Map the common
  /// extensions to their UTI here.
  static func makeRAWFilter(data: Data, identifierHint: String?) -> CIRAWFilter? {
    guard let raw = identifierHint?.lowercased(), !raw.isEmpty else { return nil }
    // Already a UTI — pass through. Anything containing a "." that's
    // not a leading dot is presumed to be a UTI (`com.adobe.raw-image`,
    // `public.tiff`).
    if raw.contains(".") {
      return CIRAWFilter(imageData: data, identifierHint: raw)
    }
    // Resolve via UniformTypeIdentifiers — the modern path. Falls
    // through to nil for unknown extensions; the caller will use the
    // CGImageSource fallback in that case.
    guard let type = UTType(filenameExtension: raw),
      let identifier = type.identifier as String?
    else { return nil }
    return CIRAWFilter(imageData: data, identifierHint: identifier)
  }
}
