// MapleExporter.swift — Full-resolution export (spec § 08 / § 02 Trace C).
//
// Formats: JPEG sRGB, JPEG P3, HEIC P3, TIFF 16-bit, PNG.
// This stage encodes the already-rendered pipeline output. Peak-memory tiling
// of the full-resolution render is a pipeline concern, not an encode concern —
// see docs/tickets/03-cicontext-tiled-render.md and docs/spec/05-performance.md
// § "When to tile". Core Image already tiles graph evaluation internally.
// macOS: NSSavePanel. iOS: UIActivityViewController (share sheet).

import Foundation
import CoreImage
import CoreImage.CIFilterBuiltins
import ImageIO

#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

// MARK: - ExportOptions

public struct ExportOptions: Sendable {
    public var format: ExportFileFormat
    public var quality: Double              // JPEG quality 0..1, default 0.92
    public var maxSidePixels: Int?          // nil = full resolution

    public static let defaults = ExportOptions(format: .jpegSRGB, quality: 0.92, maxSidePixels: nil)

    public init(format: ExportFileFormat, quality: Double = 0.92, maxSidePixels: Int? = nil) {
        self.format = format
        self.quality = quality
        self.maxSidePixels = maxSidePixels
    }
}

public enum ExportFileFormat: String, Sendable, CaseIterable {
    case jpegSRGB  = "jpeg_srgb"
    case jpegP3    = "jpeg_p3"
    case heicP3    = "heic_p3"
    case tiff16    = "tiff_16"
    case png       = "png"

    public var fileExtension: String {
        switch self {
        case .jpegSRGB, .jpegP3: return "jpg"
        case .heicP3:            return "heic"
        case .tiff16:            return "tiff"
        case .png:               return "png"
        }
    }

    public var uti: CFString {
        switch self {
        case .jpegSRGB, .jpegP3: return "public.jpeg" as CFString
        case .heicP3:            return "public.heic" as CFString
        case .tiff16:            return "public.tiff" as CFString
        case .png:               return "public.png"  as CFString
        }
    }

    public var displayName: String {
        switch self {
        case .jpegSRGB:  return "JPEG sRGB"
        case .jpegP3:    return "JPEG P3"
        case .heicP3:    return "HEIC P3"
        case .tiff16:    return "TIFF 16-bit"
        case .png:       return "PNG"
        }
    }

    var targetColorSpace: CGColorSpace {
        switch self {
        case .jpegSRGB:  return CGColorSpace(name: CGColorSpace.sRGB)!
        case .jpegP3, .heicP3: return CGColorSpace(name: CGColorSpace.displayP3)!
        // PNG is an 8-bit delivery format: it MUST be gamma-encoded sRGB.
        // Writing 8-bit *linear* sRGB (the old `.tiff16, .png` grouping) tagged
        // the file "sRGB IEC61966-2.1 Linear" — viewers that ignore the PNG ICC
        // (most do) read the linear bytes as gamma and render it far too dark,
        // and 8-bit linear bands hard in the shadows (#1511). TIFF stays
        // linear because it is 16-bit (a valid high-bit-depth working format).
        case .png:    return CGColorSpace(name: CGColorSpace.sRGB)!
        case .tiff16: return CGColorSpace(name: CGColorSpace.linearSRGB)!
        }
    }
}

// MARK: - MapleExporter

public struct MapleExporter: Sendable {
    /// Fallback `CIContext` for call sites with no session-owned context to
    /// reuse (direct `encodeImage` callers such as `MapleExporterTests`).
    /// The live `exportData` path below no longer uses this — see #2042.
    static let fallbackContext = CIContext(options: [
        .workingColorSpace: CGColorSpace(name: CGColorSpace.linearSRGB)!,
        .outputColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
    ])

    // MARK: - Export to Data

    /// Render the session's pipeline output and encode to the requested format.
    ///
    /// `renderForExport()` returns a *lazy* CIImage graph rooted at the
    /// full-resolution scene-linear decode. The peak-memory cost of a large
    /// export is in evaluating that graph, not in this encode step: Core
    /// Image's renderer tiles graph evaluation internally to respect the GPU
    /// working-set limit, and the fp16-intermediate / `cacheIntermediates:
    /// false` / pipeline-tile work that bounds it further is tracked in
    /// docs/tickets/03-cicontext-tiled-render.md (see also
    /// docs/spec/05-performance.md § "When to tile"). The encode itself needs
    /// the whole output buffer in memory — ImageIO has no public API to stream
    /// a single image to a destination strip by strip — so there is nothing
    /// useful to tile here. One encode path therefore serves every size and
    /// keeps each format's color space and bit depth correct.
    ///
    /// #2042 — the final encode now reuses `session.pipeline.context`
    /// instead of standing up a second, separately-configured Metal-backed
    /// `CIContext`. `renderForExport()` above already evaluates the export
    /// graph through that same context, so it's already resident; minting
    /// `fallbackContext` as well would keep a SECOND GPU resource cache
    /// (command queue, texture pool) alive for the whole export, on top of
    /// the pipeline's, for no benefit. Every encode call below passes an
    /// explicit `colorSpace:` argument, which is what actually determines
    /// each format's output color space (`workingColorSpace` only affects
    /// internal compositing math) — see the PR description for the one
    /// residual case (`maxSidePixels` resample) this doesn't fully rule out.
    public static func exportData(session: EditSession, options: ExportOptions) async throws -> Data {
        // Full-quality bake. Bypasses the editor's preview-quality decoded
        // cache so the exported pixels go through the parity-gated path.
        let ci = try await session.renderForExport()
        // `pipeline` is an immutable `let` of actor (hence Sendable) type,
        // so — like `ImageEditPipeline.context` itself (see that file's own
        // comment) — this reads synchronously despite `EditSession` being
        // `@MainActor`; no isolation hop actually happens here.
        let context = session.pipeline.context
        let scaled = scaledImage(ci, maxSide: options.maxSidePixels)
        return try encodeImage(scaled, options: options, context: context)
    }

    // MARK: - macOS: NSSavePanel

    #if os(macOS)
    @MainActor
    public static func exportWithSavePanel(session: EditSession, options: ExportOptions) async throws {
        let panel = NSSavePanel()
        panel.title = "Export"
        panel.nameFieldStringValue = "\(session.asset.displayName).\(options.format.fileExtension)"
        panel.allowedFileTypes = [options.format.fileExtension]
        guard panel.runModal() == .OK, let url = panel.url else { return }

        let data = try await exportData(session: session, options: options)
        try data.write(to: url, options: .atomic)
    }
    #endif

    // MARK: - iOS: Share Sheet

    #if os(iOS)
    @MainActor
    public static func shareSheet(
        session: EditSession,
        options: ExportOptions,
        sourceView: UIView
    ) async throws -> UIActivityViewController {
        let data = try await exportData(session: session, options: options)
        let tmpURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(session.asset.displayName).\(options.format.fileExtension)")
        try data.write(to: tmpURL, options: .atomic)
        let vc = UIActivityViewController(activityItems: [tmpURL], applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = sourceView
        return vc
    }
    #endif

    // MARK: - Encode

    /// The single encode path for every export size. Renders `image` into the
    /// requested format's native color space and bit depth. Package-internal
    /// (not `public`) so `MapleExporterTests` can exercise it directly without
    /// standing up a full `EditSession`.
    ///
    /// `context` defaults to `fallbackContext` so existing direct callers
    /// (tests) keep compiling; `exportData` passes the session's own
    /// pipeline context instead (#2042) so export doesn't stand up a
    /// second Metal-backed `CIContext` alongside the one already resident
    /// for the render.
    static func encodeImage(
        _ image: CIImage,
        options: ExportOptions,
        context: CIContext = fallbackContext
    ) throws -> Data {
        let cs = options.format.targetColorSpace
        switch options.format {
        case .jpegSRGB, .jpegP3:
            guard let data = context.jpegRepresentation(of: image, colorSpace: cs, options: [
                kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption:
                    options.quality
            ]) else { throw ExportError.encodeFailed(options.format) }
            return data

        case .heicP3:
            // RGBA16 = 16-bit half-float per channel (HEIC supports 10-bit
            // and bumps file size only ~5%; gives the P3 gamut headroom
            // it deserves without 8-bit posterization on smooth gradients).
            guard let data = context.heifRepresentation(of: image, format: .RGBA16, colorSpace: cs, options: [
                kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption:
                    options.quality
            ]) else { throw ExportError.encodeFailed(options.format) }
            return data

        case .tiff16:
            // 16-bit per channel — this case was previously named
            // `tiff16` but used `createCGImage` without `format:` (which
            // defaults to 8-bit BGRA). Explicit `.RGBA16` honors the name.
            guard let cgImg = context.createCGImage(
                image, from: image.extent, format: .RGBA16, colorSpace: cs
            ) else {
                throw ExportError.encodeFailed(options.format)
            }
            let mutableData = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(
                mutableData, "public.tiff" as CFString, 1, nil
            ) else { throw ExportError.encodeFailed(options.format) }
            CGImageDestinationAddImage(dest, cgImg, [
                kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFCompression: 1]
            ] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else {
                throw ExportError.encodeFailed(options.format)
            }
            return mutableData as Data

        case .png:
            guard let data = context.pngRepresentation(of: image, format: .RGBA8, colorSpace: cs)
            else { throw ExportError.encodeFailed(options.format) }
            return data
        }
    }

    // MARK: - Scale

    /// Downscale so the long edge fits `maxSide` (nil = full resolution).
    /// Package-internal so `MapleExporterTests` can verify the resize that the
    /// export path applies before encoding.
    static func scaledImage(_ image: CIImage, maxSide: Int?) -> CIImage {
        guard let maxSide else { return image }
        let w = image.extent.width, h = image.extent.height
        let longest = max(w, h)
        guard longest > CGFloat(maxSide) else { return image }
        let scale = CGFloat(maxSide) / longest
        return image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    }
}

// MARK: - ExportError

public enum ExportError: Error, LocalizedError {
    case renderFailed
    case encodeFailed(ExportFileFormat)

    public var errorDescription: String? {
        switch self {
        case .renderFailed: return "Failed to render image for export"
        case .encodeFailed(let fmt): return "Failed to encode image as \(fmt.displayName)"
        }
    }
}
