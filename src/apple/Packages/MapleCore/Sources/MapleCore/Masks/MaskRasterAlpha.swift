// MaskRasterAlpha.swift — turn a coverage raster into an alpha-carrying
// image the UI can tint (#3354).
//
// `PersonSkinMaskService` writes rasters as 8-bit GRAYSCALE PNGs (PNG
// colour type 0): coverage lives in LUMINANCE, and there is no alpha
// channel — every pixel is fully opaque. That is a fine storage format, but
// it is the opposite of what a SwiftUI template image wants: template
// rendering tints by ALPHA, so handing it the raster directly paints the
// whole frame a flat red, with the skin indistinguishable from the
// background. It looks exactly like "the mask selected everything".
//
// This rebuilds the raster as premultiplied-white RGBA with alpha taken
// from luminance, so a tint lands only where coverage is, and feathered
// edges stay feathered.

import CoreGraphics
import Foundation

public enum MaskRasterAlpha {
    /// White pixels whose alpha is `source`'s luminance. Returns `nil` if a
    /// bitmap context or data provider cannot be made.
    public static func alphaFromLuminance(_ source: CGImage) -> CGImage? {
        let width = source.width
        let height = source.height
        guard width > 0, height > 0 else { return nil }

        // Redraw through an 8-bit gray context rather than trusting the
        // source's own layout: the PNG decoder can hand back any of several
        // representations, and this pins the byte order the loop below
        // assumes.
        var luma = [UInt8](repeating: 0, count: width * height)
        let drew: Bool = luma.withUnsafeMutableBytes { raw in
            guard
                let ctx = CGContext(
                    data: raw.baseAddress, width: width, height: height,
                    bitsPerComponent: 8, bytesPerRow: width,
                    space: CGColorSpaceCreateDeviceGray(),
                    bitmapInfo: CGImageAlphaInfo.none.rawValue)
            else { return false }
            ctx.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drew else { return nil }

        // Premultiplied white: with alpha = a, the colour channels are also
        // a (white × a), which is what `premultipliedLast` requires.
        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        for i in 0..<(width * height) {
            let a = luma[i]
            rgba[i * 4 + 0] = a
            rgba[i * 4 + 1] = a
            rgba[i * 4 + 2] = a
            rgba[i * 4 + 3] = a
        }

        guard let provider = CGDataProvider(data: Data(rgba) as CFData) else { return nil }
        return CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }
}
