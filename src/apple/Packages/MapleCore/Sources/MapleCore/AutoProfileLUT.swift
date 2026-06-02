//  AutoProfileLUT.swift
//
//  Wires the per-image Auto Profile curve (#812) into the Apple canvas.
//
//  Architecture (see `docs/architecture.md` § view transform and the long
//  comment in `ImageEditPipeline.processSceneLinear`):
//
//    * The Rust FFI scene-linear chain (`applySceneLinearChainViaFFI`) runs
//      the develop chain through **AgX** and hands back a post-AgX
//      display-linear Rec.2020 fp16 buffer. The rec2020→sRGB + gamma encode
//      is implicit at the CoreImage `createCGImage` boundary — there is no
//      explicit Metal "final-encode" shader on Apple.
//
//    * `Profile::Auto` (#550) is a per-image, bounded, post-AgX tone residual
//      fitted and applied in **f32 sRGB-encoded display space**. The CPU
//      reference (`maple-cli render --profile auto`) fits the curve there and
//      `bake_profile_lut` samples `apply_curve` over a regular [0,1]³ grid in
//      that same space. So the LUT can only be sampled where the pixels are
//      sRGB-gamma-encoded sRGB-primary [0,1].
//
//    * On Apple that space is reached by tagging a `CIColorCubeWithColorSpace`
//      filter with the **sRGB** color space and applying it as the LAST op
//      before the canvas raster. CoreImage encodes working→sRGB, applies the
//      cube (= `apply_curve` in display space), then converts the
//      cube-output sRGB → the canvas output (P3). This reuses CoreImage's
//      color management for the encode rather than a hand-rolled kernel that
//      would have to byte-match it — keeping `Profile::Neutral` byte-identical
//      to today's AgX canvas.
//
//  The fit is a cold, per-image operation (JPEG extract + full develop, far
//  over the 16ms slider budget). It is fetched once via FFI, baked into a
//  33³ cube, wrapped in a reusable `CIFilter`, and cached keyed on the RAW
//  URL + mtime. The cube is rebuilt only when the image changes — never per
//  slider tick (per #840's per-image boundary).

import CoreImage
import Foundation
import RawPipeline
import os

private let autoProfileLog = Logger(subsystem: "app.justmaple.aperture", category: "auto-profile")

/// Process-lifetime cache + builder for the `Profile::Auto` display-space
/// CIColorCube. Keyed on the RAW file URL + modification time so a sidecar
/// edit (which never changes the embedded JPEG) reuses the baked cube and a
/// genuinely different file re-fits.
public actor AutoProfileLUT {
    public static let shared = AutoProfileLUT()

    /// Flat f32 length of a serialized `ProfileCurve`
    /// (`raw_core::view::auto_profile::PROFILE_CURVE_FLAT_LEN`). cbindgen does
    /// not emit the Rust `const`, so it is mirrored here; the FFI rejects any
    /// other length, so a drift surfaces immediately as `rc=0` failing to
    /// write rather than silent corruption.
    static let curveFlatLen = 220
    /// Default 3D-LUT edge (`raw_core::view::auto_profile::DEFAULT_LUT_SIZE`).
    static let lutSize = 33

    /// CIColorCube wants its cube data tagged in the color space the cube was
    /// authored in. The Auto Profile curve is fit/baked in sRGB-gamma-encoded
    /// sRGB-primary space, so the cube is an sRGB cube.
    private static let cubeColorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    private struct Key: Hashable {
        let path: String
        let mtime: TimeInterval
        let quality: Int32
    }

    /// A cached entry. `filter == nil` is a NEGATIVE cache — the fit failed or
    /// the model is not Auto, so the canvas takes plain AgX. Caching the
    /// negative result keeps the (slow) FFI fit from re-running every tick on
    /// images that have no usable embedded JPEG.
    private var cache: [Key: CIFilter?] = [:]

    private init() {}

    /// Return the ready-to-apply `CIColorCubeWithColorSpace` filter for this
    /// RAW under `Profile::Auto`, or `nil` when Auto does not apply (not Auto,
    /// no embedded JPEG, degenerate fit, or any FFI error — all of which mean
    /// "render plain AgX"). The first call per image runs the FFI fit + bake
    /// (cold, seconds on a 100MP RAW); subsequent calls return the cached
    /// filter.
    ///
    /// `quality` must match the quality the displayed buffer was developed at
    /// so the curve matches the pixels it modifies.
    public func filter(
        forRawAt url: URL,
        profile: Profile,
        quality: PipelineRenderer.Quality = .full
    ) -> CIFilter? {
        guard profile == .auto else { return nil }

        let mtime = (try? FileManager.default
            .attributesOfItem(atPath: url.path)[.modificationDate] as? Date)??
            .timeIntervalSince1970 ?? 0
        let key = Key(path: url.path, mtime: mtime, quality: quality.rawValue)
        if let cached = cache[key] {
            return cached
        }

        let built = Self.buildFilter(rawPath: url.path, quality: quality)
        cache[key] = built
        return built
    }

    /// Fetch the fitted curve via FFI, bake the 33³ display-space LUT via
    /// FFI, expand to a CIColorCube RGBA float buffer, and wrap it in a
    /// `CIColorCubeWithColorSpace` filter tagged sRGB. Returns `nil` on the
    /// no-curve fallback (`rc == 1`) or any error.
    nonisolated static func buildFilter(
        rawPath: String,
        quality: PipelineRenderer.Quality
    ) -> CIFilter? {
        var curve = [Float](repeating: 0, count: curveFlatLen)
        let rc = rawPath.withCString { cpath -> Int32 in
            curve.withUnsafeMutableBufferPointer { buf in
                maple_compute_profile_curve(cpath, nil, quality.rawValue, buf.baseAddress)
            }
        }
        guard rc == 0 else {
            if rc != 1 {
                let msg = maple_last_error().map { String(cString: $0) } ?? "unknown"
                autoProfileLog.error("maple_compute_profile_curve rc=\(rc) for \(rawPath, privacy: .public): \(msg, privacy: .public)")
            } else {
                autoProfileLog.notice("Auto Profile: no curve for \(rawPath, privacy: .public) (no JPEG / degenerate) — plain AgX")
            }
            return nil
        }

        let filter = buildFilterFromCurve(curve)
        if filter != nil {
            autoProfileLog.notice("Auto Profile: baked \(lutSize)³ display-space cube for \(rawPath, privacy: .public)")
        }
        return filter
    }

    /// Bake a serialized `ProfileCurve` (`PROFILE_CURVE_FLAT_LEN` f32) into a
    /// 33³ display-space 3D LUT via the FFI and wrap it in a
    /// `CIColorCubeWithColorSpace` filter tagged sRGB. Exposed (not private)
    /// so the #812 cube-faithfulness test can drive it with a synthetic curve
    /// without a RAW. Returns `nil` on a bake error.
    nonisolated static func buildFilterFromCurve(_ curve: [Float]) -> CIFilter? {
        let n = lutSize
        // FFI LUT layout: n³ RGB triplets, R fastest — out[((b*n+g)*n+r)*3+c].
        var lut = [Float](repeating: 0, count: n * n * n * 3)
        let lutRC = curve.withUnsafeBufferPointer { cbuf -> Int32 in
            lut.withUnsafeMutableBufferPointer { lbuf in
                maple_compute_profile_lut(
                    cbuf.baseAddress, UInt(cbuf.count), UInt32(n), lbuf.baseAddress
                )
            }
        }
        guard lutRC == 0 else {
            autoProfileLog.error("maple_compute_profile_lut rc=\(lutRC)")
            return nil
        }

        // CIColorCube wants RGBA float with red varying fastest — same index
        // order as the FFI's R-fastest layout. Expand each RGB triplet to
        // RGBA with alpha = 1.0 (straight; at alpha 1 the premultiplied
        // ambiguity is moot).
        let entries = n * n * n
        var cube = [Float](repeating: 0, count: entries * 4)
        for i in 0..<entries {
            cube[i * 4 + 0] = lut[i * 3 + 0]
            cube[i * 4 + 1] = lut[i * 3 + 1]
            cube[i * 4 + 2] = lut[i * 3 + 2]
            cube[i * 4 + 3] = 1.0
        }
        let data = cube.withUnsafeBytes { Data($0) }

        guard let filter = CIFilter(name: "CIColorCubeWithColorSpace") else {
            autoProfileLog.error("CIColorCubeWithColorSpace unavailable")
            return nil
        }
        filter.setValue(n, forKey: "inputCubeDimension")
        filter.setValue(data, forKey: "inputCubeData")
        filter.setValue(cubeColorSpace, forKey: "inputColorSpace")
        return filter
    }

    /// Apply a resolved Auto Profile cube to a processed CIImage. The filter
    /// is the LAST display-space op before the canvas raster, mirroring the
    /// CPU path's `auto_profile` → quantize order. No-op (returns the input
    /// unchanged) when `filter` is nil so `Profile::Neutral` stays
    /// byte-identical to the AgX-only canvas.
    public nonisolated static func apply(_ filter: CIFilter?, to image: CIImage) -> CIImage {
        guard let filter else { return image }
        filter.setValue(image, forKey: kCIInputImageKey)
        guard let out = filter.outputImage else { return image }
        // CIColorCube can expand the extent to infinite; clamp back to the
        // input extent so downstream crop/materialise math is unaffected.
        return out.cropped(to: image.extent)
    }
}
