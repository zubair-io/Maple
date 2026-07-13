// ThumbnailEncoder.swift — shared AVIF thumbnail encoder.
//
// `CIContext` has no `avifRepresentation` (only jpegRepresentation /
// heifRepresentation / pngRepresentation / tiffRepresentation), so the
// on-disk thumbnail cache format change from JPEG to AVIF goes through
// `CGImageDestination` directly instead. `public.avif` is a system-registered
// UTI (conforms to `public.heif-standard`, MIME `image/avif`) and is
// ImageIO-writable on this project's deployment floor (macOS 14 / iOS 26,
// both well above the macOS 13 / iOS 16 floor where ImageIO gained AVIF
// encode support) — but there is no Apple-provided `UTType.avif` constant,
// so the identifier is spelled out explicitly.

import CoreImage
import ImageIO
import UniformTypeIdentifiers

public enum ThumbnailEncoder {
    /// On-disk thumbnail UTI.
    public static let uti: CFString = "public.avif" as CFString
    public static let utType: UTType = UTType("public.avif")!

    /// AVIF quality on ImageIO's 0...1 lossy scale (mirrors the old
    /// `ThumbnailDiskCache.jpegQuality` constant's scale, NOT the same
    /// perceptual mapping — AVIF reaches equal/better quality at a lower
    /// number). Favors smaller/faster-decoding files over encode cost:
    /// thumbnails are decoded on every grid scroll but encoded once.
    public static let quality: CGFloat = 0.5

    /// Encode an already-realized `CGImage` to AVIF. Returns `nil` on any
    /// ImageIO failure (caller decides whether to log or silently drop, same
    /// contract as the old `CIContext.jpegRepresentation` call sites).
    public static func encode(_ cg: CGImage, quality: CGFloat = quality) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, uti, 1, nil) else { return nil }
        CGImageDestinationAddImage(
            dest, cg,
            [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        )
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }

    /// Render a `CIImage` to AVIF, tagging sRGB — parity with the old
    /// `jpegRepresentation(of:colorSpace: sRGB, options:)` call: `ctx`
    /// renders into sRGB and the resulting `CGImage` carries that color
    /// space, which `CGImageDestinationAddImage` embeds in the output.
    public static func encode(_ ci: CIImage, ctx: CIContext, quality: CGFloat = quality) -> Data? {
        let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let cg = ctx.createCGImage(ci, from: ci.extent, format: .RGBA8, colorSpace: sRGB)
        else { return nil }
        return encode(cg, quality: quality)
    }
}
