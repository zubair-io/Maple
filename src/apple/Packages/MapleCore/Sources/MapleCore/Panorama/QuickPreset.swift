// QuickPreset.swift — Apple-only fast-path panorama stitcher (T5.7).
//
// Quick preset trade-offs vs. the Rust Quality preset:
//   - JPEG / HEIF only (DNG / TIFF → throws unsupportedInputFormat).
//   - Apple-platform only (gated by canImport(Vision)).
//   - GPU-accelerated alignment via VNImageHomographicAlignmentRequest;
//     single-band CIBlendWithMask compositing (no graph-cut seams).
//   - Faster than the CPU Rust pipeline; lower quality for edge seams.
//
// MVP scope (T5.7):
//   - Full Vision homography alignment (VNImageHomographicAlignmentRequest).
//   - Simple linear-weight seam masks via CIImage filters.
//   - Single-band compositing: no MPSImageLaplacianPyramid multi-band blending.
//   - Multi-band MPS blending deferred to a follow-up task per T5.7 guidance.
//
// VNImageHomographicAlignmentRequest availability:
//   - macOS 14+ / iOS 17+ — matches MapleCore's minimum deployment targets
//     (Package.swift: .macOS(.v14) / .iOS(.v17)).
//
// Threading:
//   - `stitch(images:options:)` is `async` and offloads Vision work onto a
//     `Task.detached` at `.userInitiated` priority so it does not block the
//     cooperative thread pool.

#if canImport(Vision)
import Vision
import CoreImage
import CoreImage.CIFilterBuiltins
import ImageIO
import Foundation

// MARK: - QuickPresetError

public enum QuickPresetError: LocalizedError, Sendable {
    /// Input format is not JPEG or HEIF. DNG / TIFF must use the Quality preset.
    case unsupportedInputFormat(String)
    /// VNImageHomographicAlignmentRequest returned no observations.
    case alignmentFailed(String)
    /// CIImage compositing or canvas construction failed.
    case blendFailed(String)

    public var errorDescription: String? {
        switch self {
        case .unsupportedInputFormat(let msg):
            return "Quick preset: unsupported input format — \(msg). Use JPEG or HEIF input."
        case .alignmentFailed(let msg):
            return "Quick preset: alignment failed — \(msg)"
        case .blendFailed(let msg):
            return "Quick preset: compositing failed — \(msg)"
        }
    }
}

// MARK: - QuickPreset

/// Apple-only fast-path panorama stitcher using Vision + CoreImage.
///
/// Accepts JPEG and HEIF inputs only; throws `QuickPresetError.unsupportedInputFormat`
/// for DNG, TIFF, and unrecognised formats. For those inputs, use the Quality preset
/// which routes through the Rust core via `PanoHandle`.
///
/// Alignment uses `VNImageHomographicAlignmentRequest` (macOS 14+ / iOS 17+).
/// Compositing uses CIImage transforms + `CIBlendWithMask` (single-band linear blend).
/// Multi-band MPS blending is deferred to a follow-up task.
public enum QuickPreset {

    // MARK: - Public entry point

    /// Stitch JPEG/HEIF byte buffers into a CIImage.
    ///
    /// - Parameters:
    ///   - images: Two or more JPEG or HEIF image buffers in left-to-right order.
    ///   - options: `PanoramaOptions` (projection / parallax / maxDimension).
    ///             Only `maxDimension` is respected today; projection and parallax
    ///             are handled by the Quality (Rust) preset.
    /// - Returns: A `CIImage` composited in sRGB (the display color space of the
    ///            decoded JPEG/HEIF inputs). Unlike the Quality preset the result
    ///            is NOT linear Rec.2020 — it is display-referred sRGB.
    /// - Throws: `QuickPresetError` on format rejection, alignment failure, or
    ///           compositing failure.
    public static func stitch(
        images: [Data],
        options: PanoramaOptions = .default
    ) async throws -> CIImage {
        guard images.count >= 2 else {
            throw QuickPresetError.blendFailed("at least 2 images required")
        }

        // 1. Format-validate: sniff magic bytes; reject DNG/TIFF/RAW.
        for (i, data) in images.enumerated() {
            try validateFormat(data, index: i)
        }

        // 2. Decode each Data → CIImage.
        let ciImages: [CIImage] = try images.enumerated().map { i, data in
            guard let img = CIImage(data: data) else {
                throw QuickPresetError.blendFailed("could not decode image at index \(i)")
            }
            return img
        }

        // 3. Compute homographies via VNImageHomographicAlignmentRequest on a
        //    detached Task so we don't block the cooperative thread pool.
        let homographies: [CGAffineTransform] = try await Task.detached(priority: .userInitiated) {
            try computeHomographies(ciImages: ciImages)
        }.value

        // 4. Build the canvas (union of all warped extents), apply optional
        //    maxDimension clamp, then composite.
        return try compose(
            ciImages: ciImages,
            homographies: homographies,
            options: options
        )
    }

    // MARK: - Format validation

    /// Sniff the first bytes of `data` and throw if the format is not JPEG or HEIF.
    ///
    /// Magic bytes checked:
    ///   - JPEG:  FF D8 FF
    ///   - HEIF/HEIC: 4-byte box size, then "ftyp" at offset 4 (ISO base media).
    ///   - DNG/TIFF: 49 49 (LE) or 4D 4D (BE) — rejected.
    ///   - PNG:   89 50 4E 47 — rejected (send to Quality preset for best results).
    static func validateFormat(_ data: Data, index: Int) throws {
        guard data.count >= 12 else {
            throw QuickPresetError.unsupportedInputFormat(
                "image[\(index)] is too small to identify (\(data.count) bytes)"
            )
        }

        let b = data.prefix(12)

        // JPEG: FF D8 FF
        if b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF {
            return
        }

        // DNG / TIFF (little-endian: 49 49 2A 00, big-endian: 4D 4D 00 2A)
        if (b[0] == 0x49 && b[1] == 0x49) || (b[0] == 0x4D && b[1] == 0x4D) {
            throw QuickPresetError.unsupportedInputFormat(
                "image[\(index)] appears to be DNG/TIFF — use the Quality preset for RAW inputs"
            )
        }

        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47 {
            throw QuickPresetError.unsupportedInputFormat(
                "image[\(index)] is PNG — Quick preset accepts JPEG and HEIF only"
            )
        }

        // HEIF/HEIC/AVIF: ISO base media format — "ftyp" box at offset 4.
        // Box layout: 4 bytes (uint32 BE box size) + 4 bytes ("ftyp").
        if b[4] == 0x66 && b[5] == 0x74 && b[6] == 0x79 && b[7] == 0x70 {
            return
        }

        throw QuickPresetError.unsupportedInputFormat(
            "image[\(index)] has an unrecognised format (first bytes: \(b.map { String(format: "%02X", $0) }.joined(separator: " ")))"
        )
    }

    // MARK: - Homography computation

    /// Compute pairwise homographies from each image to the coordinate space of
    /// `ciImages[0]` (the reference / anchor frame).
    ///
    /// Uses `VNImageHomographicAlignmentRequest` to align image[i+1] → image[i],
    /// then chains the resulting `CGAffineTransform`s so all images map to the
    /// reference frame of image[0].
    ///
    /// Returns an array of length `ciImages.count`.  The first element is the
    /// identity transform (image[0] is the reference).
    ///
    /// - Note: This function is synchronous and is intended to be called from
    ///   a `Task.detached` block to avoid blocking the cooperative thread pool.
    @Sendable
    static func computeHomographies(ciImages: [CIImage]) throws -> [CGAffineTransform] {
        var transforms = [CGAffineTransform](repeating: .identity, count: ciImages.count)
        // transforms[0] = .identity (reference frame)

        for i in 1..<ciImages.count {
            let floating = ciImages[i]
            let reference = ciImages[i - 1]

            // Convert CIImages to CGImages for Vision.
            let ctx = CIContext(options: [.useSoftwareRenderer: false])
            guard let floatingCG = ctx.createCGImage(floating, from: floating.extent),
                  let referenceCG = ctx.createCGImage(reference, from: reference.extent)
            else {
                throw QuickPresetError.alignmentFailed(
                    "could not convert image pair (\(i-1), \(i)) to CGImage for Vision"
                )
            }

            let transform = try alignWithVision(
                floating: floatingCG,
                reference: referenceCG,
                index: i
            )

            // Chain: the transform from image[i] → image[i-1], combined with
            // the accumulated transform from image[i-1] → image[0].
            transforms[i] = transform.concatenating(transforms[i - 1])
        }

        return transforms
    }

    /// Align one CGImage to another using `VNImageHomographicAlignmentRequest`.
    ///
    /// Returns the `CGAffineTransform` that maps `floating` into the coordinate
    /// space of `reference`. On degenerate results (translation-only or tiny
    /// determinant) the function falls back to a pure translation guess derived
    /// from the image width — acceptable for the Quick MVP.
    private static func alignWithVision(
        floating: CGImage,
        reference: CGImage,
        index: Int
    ) throws -> CGAffineTransform {
        let request = VNHomographicImageRegistrationRequest(targetedCGImage: reference, options: [:])

        let handler = VNImageRequestHandler(cgImage: floating, options: [:])
        do {
            try handler.perform([request])
        } catch {
            throw QuickPresetError.alignmentFailed(
                "VNImageHomographicAlignmentRequest failed for image[\(index)]: \(error.localizedDescription)"
            )
        }

        guard let observation = request.results?.first as? VNImageHomographicAlignmentObservation else {
            // No observation — fall back to a horizontal offset heuristic.
            // This is acceptable for the Quick preset MVP: if Vision can't align,
            // we assume a left-to-right shooting pattern and shift by ~80% of the
            // floating image width. The user gets a rough stitch that may have
            // a visible seam — better than throwing.
            let shiftX = CGFloat(floating.width) * 0.8
            return CGAffineTransform(translationX: shiftX, y: 0)
        }

        let mat = observation.warpTransform   // simd_float3x3
        // Convert the 3×3 homography to a CGAffineTransform approximation.
        // Full perspective is not representable in CGAffineTransform; we extract
        // the affine part (top-left 2×2 + translation column) and ignore the
        // projective row. This is accurate when the homography has small perspective
        // distortion (overlap-heavy shots with parallel framing).
        let a = CGFloat(mat.columns.0.x)  // col0.x
        let b = CGFloat(mat.columns.0.y)  // col0.y
        let c = CGFloat(mat.columns.1.x)  // col1.x
        let d = CGFloat(mat.columns.1.y)  // col1.y
        let tx = CGFloat(mat.columns.2.x) // col2.x
        let ty = CGFloat(mat.columns.2.y) // col2.y

        // Normalise the homography by w (columns.2.z) if it differs from 1.
        let w = CGFloat(mat.columns.2.z)
        if abs(w) < 1e-6 {
            // Degenerate — fall back to horizontal shift.
            return CGAffineTransform(translationX: CGFloat(floating.width) * 0.8, y: 0)
        }
        let inv = 1.0 / w
        return CGAffineTransform(a: a * inv, b: b * inv, c: c * inv, d: d * inv,
                                 tx: tx * inv, ty: ty * inv)
    }

    // MARK: - Canvas composition

    /// Build the panorama canvas from warped CIImages and linear seam masks.
    ///
    /// Steps:
    ///   1. Warp each input by its homography using CIImage.transformed(by:).
    ///   2. Compute the union bounding box of all warped extents.
    ///   3. Clamp to `options.maxDimension` if set.
    ///   4. Composite images left-to-right using `CIBlendWithMask` with a
    ///      simple linear-weight alpha mask (single-band — no MPS multi-band).
    ///
    /// The anchor image (index 0) is the background; subsequent images are
    /// blended on top from left to right.
    private static func compose(
        ciImages: [CIImage],
        homographies: [CGAffineTransform],
        options: PanoramaOptions
    ) throws -> CIImage {
        // 1. Warp each image into the reference coordinate space.
        var warped: [CIImage] = []
        for (img, transform) in zip(ciImages, homographies) {
            if transform.isIdentity {
                warped.append(img)
            } else {
                warped.append(img.transformed(by: transform))
            }
        }

        // 2. Union bounding box.
        var canvas = warped[0].extent
        for img in warped.dropFirst() {
            canvas = canvas.union(img.extent)
        }

        guard canvas.width > 0, canvas.height > 0,
              canvas.width.isFinite, canvas.height.isFinite else {
            throw QuickPresetError.blendFailed("degenerate canvas extent after warping")
        }

        // 3. Optional maxDimension clamp (uniform scale so aspect ratio is preserved).
        var scaleTransform = CGAffineTransform.identity
        if options.maxDimension > 0 {
            let maxDim = CGFloat(options.maxDimension)
            let longEdge = max(canvas.width, canvas.height)
            if longEdge > maxDim {
                let scale = maxDim / longEdge
                scaleTransform = CGAffineTransform(scaleX: scale, y: scale)
                canvas = canvas.applying(scaleTransform)
                warped = warped.map { $0.transformed(by: scaleTransform) }
            }
        }

        // 4. Composite left-to-right with linear seam masks.
        //    Start from the anchor (warped[0]) and blend each subsequent image on top.
        var composite: CIImage = warped[0]

        for i in 1..<warped.count {
            let top = warped[i]
            let topExtent = top.extent

            // Build a simple linear-weight gradient mask in the overlap region.
            // The mask fades the top image in from left (transparent) to right
            // (opaque) within the overlapping X extent. This is a single-band
            // approximation of multi-band blending — good enough for Quick preset.
            let mask = makeLinearSeamMask(
                canvasExtent: canvas,
                topExtent: topExtent
            )

            // CIBlendWithMask: output = top * mask + background * (1 - mask)
            let blendFilter = CIFilter.blendWithMask()
            blendFilter.inputImage = top
            blendFilter.backgroundImage = composite
            blendFilter.maskImage = mask

            guard let blended = blendFilter.outputImage else {
                throw QuickPresetError.blendFailed("CIBlendWithMask returned nil at step \(i)")
            }
            composite = blended
        }

        // Crop to the canvas bounding box.
        return composite.cropped(to: canvas)
    }

    // MARK: - Seam mask

    /// Build a linear-gradient mask image covering `canvasExtent`.
    ///
    /// The mask fades from 0 (transparent) at the left edge of `topExtent`
    /// to 1 (opaque) at the right edge, over a blend zone equal to 25% of
    /// the top image width. Outside the blend zone the mask is either 0 or 1.
    ///
    /// This is a single-band linear approximation. Multi-band MPS blending
    /// (MPSImageLaplacianPyramid) is deferred to a follow-up task.
    private static func makeLinearSeamMask(
        canvasExtent: CGRect,
        topExtent: CGRect
    ) -> CIImage {
        let blendWidth = topExtent.width * 0.25
        let startX = topExtent.minX
        let endX   = topExtent.minX + blendWidth

        // Use CILinearGradient to build a 0→1 horizontal gradient, then
        // clamp to the canvas extent.
        let gradientFilter = CIFilter.linearGradient()
        gradientFilter.point0 = CGPoint(x: startX, y: 0)
        gradientFilter.point1 = CGPoint(x: endX,   y: 0)
        gradientFilter.color0 = CIColor(red: 0, green: 0, blue: 0, alpha: 0)
        gradientFilter.color1 = CIColor(red: 1, green: 1, blue: 1, alpha: 1)

        let gradient = gradientFilter.outputImage ?? CIImage(color: CIColor.white)
        return gradient.cropped(to: canvasExtent)
    }
}

#else // canImport(Vision)

// MARK: - QuickPresetError (non-Apple stub)

public enum QuickPresetError: LocalizedError, Sendable {
    case unsupportedInputFormat(String)
    case alignmentFailed(String)
    case blendFailed(String)

    public var errorDescription: String? {
        switch self {
        case .unsupportedInputFormat(let msg): return "Quick preset: unsupported format — \(msg)"
        case .alignmentFailed(let msg):        return "Quick preset: alignment failed — \(msg)"
        case .blendFailed(let msg):            return "Quick preset: blend failed — \(msg)"
        }
    }
}

// MARK: - QuickPreset (non-Apple stub)

/// Stub that always throws on non-Apple platforms.
///
/// The real implementation requires Vision, MetalPerformanceShaders, and
/// CoreImage, which are Apple-platform-only. On other platforms the Quality
/// preset (Rust core) is the only supported path.
public enum QuickPreset {
    public static func stitch(
        images: [Data],
        options: PanoramaOptions = .default
    ) async throws -> CIImage {
        throw NSError(
            domain: "QuickPreset",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey:
                "QuickPreset requires Apple platform (Vision + CoreImage)"]
        )
    }
}

#endif // canImport(Vision)
