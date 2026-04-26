// PanoHandle.swift — Swift wrapper around the pano_* C FFI (T5.2).
//
// C ABI surface (from RawPipeline.xcframework, built with --features pano):
//
//   int32_t pano_stitch(
//       const uint8_t *const *inputs, const size_t *input_lens, size_t n_inputs,
//       const uint8_t *const *dcps,   const size_t *dcp_lens,            // ignored
//       const PanoOptions *options,
//       PanoHandle **out_handle
//   );
//   uint32_t        pano_get_width(const PanoHandle *);
//   uint32_t        pano_get_height(const PanoHandle *);
//   const uint16_t *pano_get_pixels_f16(const PanoHandle *);
//   size_t          pano_get_pixels_len(const PanoHandle *);   // elements, not bytes
//   void            pano_free(PanoHandle *);
//
// Swift design:
//   - `PanoHandle` is a `final class` so its deinit calls `pano_free` exactly
//     once.  Marked `@unchecked Sendable` because the C-side data is immutable
//     after `pano_stitch` returns.
//   - `PanoramaOptions` is a Swift struct that maps directly to `PanoOptions`.
//   - `PanoHandle.stitch(images:options:)` is the primary entry point; it
//     marshals `[Data]` into the C-compatible pointer/length arrays and maps
//     return codes to `StitchError`.
//
// DCP note: the `dcps` / `dcp_lens` ABI parameters are accepted but currently
// ignored on the Rust side (rawler reads embedded DCPs from the DNG container).
// The Swift API does not expose them until per-frame DCP override lands (P5+).

import Foundation
import RawPipeline

// MARK: - PanoramaOptions

/// Configuration for `PanoHandle.stitch(images:options:)`.
public struct PanoramaOptions: Sendable {
    public var projection: Projection
    public var parallaxMode: ParallaxMode
    /// Long-edge clamp in pixels.  Pass 0 for unconstrained.
    public var maxDimension: UInt32

    /// Default configuration: cylindrical projection, homography parallax,
    /// unconstrained output size.
    public static let `default` = PanoramaOptions(
        projection: .cylindrical,
        parallaxMode: .homography,
        maxDimension: 0
    )

    public init(projection: Projection, parallaxMode: ParallaxMode, maxDimension: UInt32) {
        self.projection = projection
        self.parallaxMode = parallaxMode
        self.maxDimension = maxDimension
    }

    /// Output projection geometry.
    public enum Projection: UInt32, Sendable {
        case rectilinear = 0
        case cylindrical = 1
        case spherical   = 2
    }

    /// Parallax-handling strategy in the warp stage.
    /// `.tpsMesh` is accepted in the ABI but treated as `.homography` until
    /// TPS mesh warping is implemented (P4+).
    public enum ParallaxMode: UInt32, Sendable {
        case homography = 0
        case tpsMesh    = 1
    }
}

// MARK: - PanoHandle

/// Swift-safe wrapper around the opaque `PanoHandle *` returned by
/// `pano_stitch`.  Owns the underlying C-allocated image data; its `deinit`
/// calls `pano_free` exactly once.
///
/// The handle is immutable after construction — all accessors read from the
/// same heap-allocated pixel buffer that was populated by `pano_stitch`.
/// `@unchecked Sendable` is safe because the pointee is never mutated after
/// `pano_stitch` returns; concurrent reads from multiple threads are safe.
public final class PanoHandle: @unchecked Sendable {

    // MARK: - StitchError

    /// Errors thrown by `PanoHandle.stitch(images:options:)`.
    public enum StitchError: Error, LocalizedError, Sendable {
        /// n_inputs < 2, null pointer in the inputs array, or other ABI violation.
        case invalidArguments
        /// One or more inputs could not be decoded (unsupported format or corrupt data).
        case decodeFailure
        /// The stitching pipeline (ORB detection, matching, BA, warp, or blend) failed.
        case stitchFailure
        /// Reserved for future output-write errors; not currently returned.
        case outputFailure
        /// Catch-all for unexpected negative return codes.
        case unknown(Int32)

        public var errorDescription: String? {
            switch self {
            case .invalidArguments: return "Invalid arguments passed to pano_stitch"
            case .decodeFailure:    return "One or more input images could not be decoded"
            case .stitchFailure:    return "Panorama stitching pipeline failed"
            case .outputFailure:    return "Panorama output write failed"
            case .unknown(let rc):  return "pano_stitch returned unexpected code \(rc)"
            }
        }
    }

    // MARK: - Stored state

    /// Opaque C pointer.  Not introspected; all access goes through the FFI.
    private let raw: OpaquePointer

    // MARK: - Init / deinit

    fileprivate init(_ raw: OpaquePointer) {
        self.raw = raw
    }

    deinit {
        // SAFETY: `raw` came from a successful `pano_stitch` call and has not
        // been freed (we're in the first and only deinit).  pano_free is a
        // no-op for null, but raw can never be null here.
        pano_free(raw)
    }

    // MARK: - Accessors

    /// Panorama width in pixels.
    public var width: UInt32 {
        pano_get_width(raw)
    }

    /// Panorama height in pixels.
    public var height: UInt32 {
        pano_get_height(raw)
    }

    /// Number of f16 elements in the pixel buffer (`width * height * 3`).
    /// This is the element count, not the byte count.
    public var pixelsLen: Int {
        Int(pano_get_pixels_len(raw))
    }

    /// Pointer to the f16 (half-precision, stored as `UInt16`) RGB pixel buffer.
    ///
    /// The buffer is interleaved RGB f16, row-major, with `pixelsLen` elements.
    /// The pointer is valid for the lifetime of this `PanoHandle` instance.
    /// Returns `nil` if the underlying buffer is empty (should not happen after
    /// a successful stitch).
    public var pixelsF16: UnsafePointer<UInt16>? {
        pano_get_pixels_f16(raw)
    }

    // MARK: - Factory

    /// Stitch an array of in-memory image `Data` objects into a panorama.
    ///
    /// - Parameters:
    ///   - images: Two or more image buffers (PNG, JPEG, or RAW/DNG).
    ///             The order matters: images should be in left-to-right (or
    ///             top-to-bottom) shooting order for best results.
    ///   - options: Stitching options.  Defaults to cylindrical projection.
    ///
    /// - Returns: A `PanoHandle` owning the stitched panorama.
    /// - Throws: `StitchError` if stitching fails.
    public static func stitch(
        images: [Data],
        options: PanoramaOptions = .default
    ) throws -> PanoHandle {
        guard images.count >= 2 else {
            throw StitchError.invalidArguments
        }

        // Build C-compatible pointer + length arrays, keeping the Data objects
        // alive for the duration of the call via `withUnsafeBytes`.
        return try withUnsafePointerArrays(images) { ptrs, lens in
            // Build the C PanoOptions struct.
            var cOpts = PanoOptions(
                projection: options.projection.rawValue,
                parallax_mode: options.parallaxMode.rawValue,
                max_dimension: options.maxDimension
            )

            var outPtr: OpaquePointer? = nil
            let rc = ptrs.withUnsafeBufferPointer { ptrBuf in
                lens.withUnsafeBufferPointer { lenBuf in
                    pano_stitch(
                        ptrBuf.baseAddress,
                        lenBuf.baseAddress,
                        UInt(images.count),
                        nil,   // dcps: not yet exposed (P5+)
                        nil,   // dcp_lens: not yet exposed (P5+)
                        &cOpts,
                        &outPtr
                    )
                }
            }

            switch rc {
            case 0:
                guard let p = outPtr else {
                    throw StitchError.stitchFailure
                }
                return PanoHandle(p)
            case -1: throw StitchError.invalidArguments
            case -2: throw StitchError.decodeFailure
            case -3: throw StitchError.stitchFailure
            case -4: throw StitchError.outputFailure
            default: throw StitchError.unknown(rc)
            }
        }
    }
}

// MARK: - Private helpers

/// Invoke `body` with parallel arrays of `UnsafePointer<UInt8>?` and `UInt`
/// corresponding to the bytes of each `Data` in `dataArray`.
///
/// All `Data` objects remain alive and pinned for the duration of the call
/// via nested `withUnsafeBytes` closures.
private func withUnsafePointerArrays<R>(
    _ dataArray: [Data],
    body: ([UnsafePointer<UInt8>?], [UInt]) throws -> R
) rethrows -> R {
    // Recursively pin each Data and collect the pointers.
    func go(
        _ remaining: ArraySlice<Data>,
        _ accPtrs: inout [UnsafePointer<UInt8>?],
        _ accLens: inout [UInt],
        _ body: ([UnsafePointer<UInt8>?], [UInt]) throws -> R
    ) rethrows -> R {
        if remaining.isEmpty {
            return try body(accPtrs, accLens)
        }
        return try remaining.first!.withUnsafeBytes { buf in
            accPtrs.append(buf.baseAddress?.assumingMemoryBound(to: UInt8.self))
            accLens.append(UInt(buf.count))
            defer {
                accPtrs.removeLast()
                accLens.removeLast()
            }
            return try go(remaining.dropFirst(), &accPtrs, &accLens, body)
        }
    }

    var ptrs: [UnsafePointer<UInt8>?] = []
    var lens: [UInt] = []
    ptrs.reserveCapacity(dataArray.count)
    lens.reserveCapacity(dataArray.count)
    return try go(dataArray[...], &ptrs, &lens, body)
}
