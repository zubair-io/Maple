// PanoramaExport.swift — wraps PanoHandle pixels in a CIImage (T5.3).
//
// Lifetime contract:
//   The f16 pixel buffer is owned by the `PanoHandle` (freed in its deinit
//   via `pano_free`).  We need the `CIImage` to keep the buffer alive until
//   the image has been rendered (e.g. to a CGImage or written to disk).
//
//   Strategy: copy the f16 bytes into a `Data` value at wrap time.  This is
//   a one-time allocation per pixel for the full panorama.  For a 100MP pano
//   this is bounded and manageable; revisit if memory profiling shows a problem.
//   The copy also makes the returned CIImage independent of the PanoHandle's
//   lifetime (the handle can be released immediately after toCIImage returns).
//
// Color space:
//   The Rust core emits linear Rec.2020 D65 f16 (despite the spec naming
//   ProPhoto — the FFI doesn't apply Rec.2020→ProPhoto today).  We tag the
//   CIImage with `CGColorSpace.itur_2020` accordingly.  If and when the Rust
//   side gains the Rec.2020→ProPhoto conversion, the tag here should change
//   to the ProPhoto space returned by `OutputColorSpace.proPhoto.cgColorSpace`.
//
// Channel layout:
//   The Rust core hands us interleaved RGB f16 (3 channels, no alpha).
//   CoreImage's public CIFormat inventory does not include a 3-channel f16
//   format (`CIFormat.RGBh` does not exist on macOS/iOS).  The nearest public
//   format is `CIFormat.RGBAh` (4-channel RGBA half-float).
//
//   We expand the packed RGB f16 buffer to RGBA f16 by inserting a fully-opaque
//   alpha channel (f16 bit pattern 0x3C00 = 1.0) after every pixel.  This is a
//   3×/4× pass over the buffer (extra 2 bytes per pixel vs. a pure copy).
//   The output bytesPerRow is `width * 4 * 2`.

import CoreImage
import Foundation

// MARK: - f16 constant

/// IEEE 754 half-precision 1.0: sign=0, exp=15 (biased), mantissa=0.
/// Bit pattern: 0_01111_0000000000 = 0x3C00.
private let f16One: UInt16 = 0x3C00

// MARK: - PanoramaExport

public enum PanoramaExport {
    /// Wrap a stitched `PanoHandle` in a `CIImage` tagged with the correct
    /// color space for the linear Rec.2020 D65 f16 buffer the Rust core emits.
    ///
    /// The Rust core emits packed RGB f16 (3 channels, no alpha).  This method
    /// expands to RGBA f16 (inserting alpha = 1.0) to satisfy `CIFormat.RGBAh`,
    /// then copies the result into a `Data` so the CIImage is independent of
    /// the `PanoHandle`'s lifetime.  Callers may release the handle immediately
    /// after this call returns.
    ///
    /// - Parameters:
    ///   - handle: A successfully stitched `PanoHandle`.
    ///   - options: The `PanoramaOptions` used to produce the handle (reserved
    ///              for future color-space routing; unused today).
    /// - Throws: `PanoramaEngineError.ciImageWrapFailed` if the handle has no
    ///           pixels or the Rec.2020 color space is unavailable.
    /// - Returns: A `CIImage` with `extent` equal to `(0, 0, width, height)`.
    public static func toCIImage(
        handle: PanoHandle,
        options: PanoramaOptions
    ) throws -> CIImage {
        guard handle.pixelsLen > 0, let rgbPtr = handle.pixelsF16 else {
            throw PanoramaEngineError.ciImageWrapFailed("handle has no pixels")
        }

        let pixelCount = Int(handle.width) * Int(handle.height)

        // Sanity check: pixelsLen must be width * height * 3.
        guard handle.pixelsLen == pixelCount * 3 else {
            throw PanoramaEngineError.ciImageWrapFailed(
                "pixelsLen \(handle.pixelsLen) ≠ width×height×3 (\(pixelCount * 3))"
            )
        }

        // Expand packed RGB f16 → RGBA f16 (inserting alpha = 1.0 per pixel).
        // Each pixel: src[3] → dst[4].
        var rgba = [UInt16](repeating: 0, count: pixelCount * 4)
        for px in 0..<pixelCount {
            rgba[px * 4 + 0] = rgbPtr[px * 3 + 0]  // R
            rgba[px * 4 + 1] = rgbPtr[px * 3 + 1]  // G
            rgba[px * 4 + 2] = rgbPtr[px * 3 + 2]  // B
            rgba[px * 4 + 3] = f16One               // A = 1.0
        }
        let data = rgba.withUnsafeBytes { Data($0) }

        // 4 channels × 2 bytes/channel per pixel.
        let bytesPerRow = Int(handle.width) * 4 * MemoryLayout<UInt16>.size

        // Tag with the actual color space the Rust core uses: linear Rec.2020 D65.
        guard let cs = CGColorSpace(name: CGColorSpace.itur_2020) else {
            throw PanoramaEngineError.ciImageWrapFailed(
                "Rec.2020 (itur_2020) color space unavailable on this OS version"
            )
        }

        // CIFormat.RGBAh = 16-bit half-precision RGBA (4 channels).
        let ciImage = CIImage(
            bitmapData: data,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: Int(handle.width), height: Int(handle.height)),
            format: .RGBAh,
            colorSpace: cs
        )

        return ciImage
    }
}
