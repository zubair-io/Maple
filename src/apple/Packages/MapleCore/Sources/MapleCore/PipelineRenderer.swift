// PipelineRenderer.swift — Swift-safe wrapper around the raw-ffi C API.
//
// FFI surface (from RawPipeline.xcframework / raw-ffi/src/lib.rs):
//
//   int32_t maple_render_file(const char* raw_path,
//                             const char* xmp_path,   // nullable
//                             MapleImageBuffer* out);
//   int32_t maple_render_bytes(const uint8_t* raw,
//                              uintptr_t len,
//                              const char* hint_ext,  // e.g. "dng"
//                              const char* xmp_path,  // nullable
//                              MapleImageBuffer* out);
//   void    maple_free_buffer(MapleImageBuffer* buffer);
//   const char* maple_last_error(void);               // thread-local
//
// Swift design:
//   - `MapleImageData` is a value type (struct) that copies pixel bytes out of
//     the C buffer, so no unsafe lifetime management leaks into callers.
//   - `PipelineRenderer` is a Sendable struct; all mutable state lives in the
//     C library's thread-local error slot.

import Foundation
import OSLog
import RawPipeline

private let pipelineLog = Logger(subsystem: "app.justmaple.aperture", category: "PipelineRenderer")

// MARK: - MapleImageData

/// Pixel buffer returned by PipelineRenderer. Owns its byte storage.
/// Pixels are packed sRGB u8, row-major, 3 bytes per pixel (R G B).
public struct MapleImageData: Sendable {
    public let width: Int
    public let height: Int
    /// Raw sRGB bytes, length == 3 * width * height
    public let pixels: Data

    public var pixelCount: Int { width * height }

    // Convenience: retrieve a single pixel (0-indexed, no bounds check in release).
    @inlinable
    public func rgb(x: Int, y: Int) -> (UInt8, UInt8, UInt8) {
        let base = (y * width + x) * 3
        return (pixels[base], pixels[base + 1], pixels[base + 2])
    }
}

// MARK: - MapleSceneLinearImageData

/// Pixel buffer returned by `PipelineRenderer.renderSceneLinear` and the
/// tile entries. Pixels are packed Rec.2020 RGBA, row-major, straight
/// (non-premultiplied) alpha (always 1.0).
///
/// Two precisions are carried by this struct depending on which FFI
/// entry produced it:
///
///   * **f32 RGBA, 16 B/px** — `renderSceneLinear*` (full + sized
///     variants). Migrated to f32 in #487 so the per-tick chain
///     consumes the scene buffer at full precision, removing the fp16
///     mantissa drop that produced visible banding near the AgX
///     shoulder when the buffer round-tripped through the legacy fp16
///     FFI. Caller wraps as `CIFormat.RGBAf`.
///   * **fp16 RGBA, 8 B/px** — `renderTile` + `decodePreviewTile`. The
///     tile FFI still returns fp16 (no `_f32` variant yet — tracked as
///     a follow-up to #487). Caller wraps as `CIFormat.RGBAh`.
///
/// `bytesPerPixel` is the discriminator; callers should never hard-code
/// it. The buffer is always row-major with `pixels.count ==
/// bytesPerPixel * width * height`.
public struct MapleSceneLinearImageData: Sendable {
    public let width: Int
    public let height: Int
    public let channels: Int            // always 4
    /// 16 for f32 RGBA (`renderSceneLinear*`), 8 for fp16 RGBA
    /// (`renderTile` / `decodePreviewTile`). Reflects the format of the
    /// underlying FFI entry — do not hard-code; route on this.
    public let bytesPerPixel: Int
    /// Packed RGBA bytes; `pixels.count == bytesPerPixel * width * height`.
    public let pixels: Data

    public var pixelCount: Int { width * height }
}

// MARK: - PipelineRenderer

/// Thread-safe renderer around the Rust `raw-ffi` staticlib.
///
/// Usage:
/// ```swift
/// let image = try PipelineRenderer.render(rawPath: url, xmpPath: sidecarURL)
/// ```
public struct PipelineRenderer: Sendable {
    // No stored properties; the FFI has no object state.
    public init() {}

    /// Render a RAW file with optional XMP sidecar.
    ///
    /// - Parameters:
    ///   - rawPath: URL to the RAW/DNG file.
    ///   - xmpPath: Optional URL to the XMP sidecar. Pass `nil` to use
    ///              `AdjustmentModel::default()`.
    /// - Returns: The rendered `MapleImageData`.
    /// - Throws: `PipelineError` if the Rust side returns a non-zero status.
    /// Render quality knob. `preview` takes the half-resolution path through
    /// the Rust pipeline (quad demosaic + 4× fewer pixels through every
    /// downstream stage) so a 100 MP RAW lands in a few seconds instead of
    /// minutes. `full` is the export path — the parity harness locks this.
    public enum Quality: Int32 {
        case full = 0
        case preview = 1
    }

    public static func render(
        rawPath: URL,
        xmpPath: URL? = nil,
        quality: Quality = .full
    ) throws -> MapleImageData {
        try rawPath.withPathCString { rawCStr in
            if let xmpPath {
                return try xmpPath.withPathCString { xmpCStr in
                    try _render(rawCStr: rawCStr, xmpCStr: xmpCStr, quality: quality)
                }
            } else {
                return try _render(rawCStr: rawCStr, xmpCStr: nil, quality: quality)
            }
        }
    }

    /// Render a RAW from an in-memory byte buffer. Required for sources that
    /// don't expose a filesystem URL (PhotoKit, self-hosted API).
    ///
    /// - Parameters:
    ///   - rawBytes: Full RAW file bytes. Ownership stays with the caller;
    ///               the bytes are copied into Rust's decoder via a borrowed
    ///               pointer.
    ///   - hint:     RAW extension hint *without* the leading dot (e.g.
    ///               `"dng"`, `"cr2"`, `"arw"`). Empty string is allowed — the
    ///               decoder will fall through to content sniffing.
    ///   - xmpPath:  Optional URL to an XMP sidecar on disk. `nil` uses
    ///               `AdjustmentModel::default()`.
    public static func render(
        rawBytes: Data,
        hint: String,
        xmpPath: URL? = nil,
        quality: Quality = .full
    ) throws -> MapleImageData {
        guard let hintCStr = hint.cString(using: .utf8) else {
            throw PipelineError.hintEncodingError(hint)
        }
        return try rawBytes.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            let base = buf.baseAddress?.assumingMemoryBound(to: UInt8.self)
            if let xmpPath {
                return try xmpPath.withPathCString { xmpCStr in
                    try _renderBytes(
                        ptr: base, len: buf.count,
                        hintCStr: hintCStr,
                        xmpCStr: xmpCStr,
                        quality: quality
                    )
                }
            } else {
                return try _renderBytes(
                    ptr: base, len: buf.count,
                    hintCStr: hintCStr,
                    xmpCStr: nil,
                    quality: quality
                )
            }
        }
    }

    // MARK: Scene-linear render (Plan 1 FFI split)

    /// Render a RAW file to a Rec.2020 fp16 RGBA scene-linear buffer.
    /// The Apple consumer is expected to import the buffer as a CIImage
    /// tagged `CGColorSpace.extendedLinearITUR_2020` and apply a view
    /// transform (AgX) + gamut convert (Rec.2020 → sRGB) downstream.
    ///
    /// Plan 1 wire — see
    /// .archived-plans/plans/2026-04-24-ffi-split-plan-1.md.
    public static func renderSceneLinear(
        rawPath: URL,
        xmpPath: URL? = nil,
        quality: Quality = .full
    ) throws -> MapleSceneLinearImageData {
        // Apple-GPU strip lives in Swift (ticket #124). The temp XMP
        // carries only the fields the Rust decode should bake; the
        // Metal chain re-applies the rest at the slider tick.
        try RawCoreBridge.withStrippedXMP(xmpPath) { strippedXMP in
            try rawPath.withPathCString { rawCStr in
                if let strippedXMP {
                    return try strippedXMP.withPathCString { xmpCStr in
                        try _renderSceneLinear(rawCStr: rawCStr, xmpCStr: xmpCStr, quality: quality)
                    }
                } else {
                    return try _renderSceneLinear(rawCStr: rawCStr, xmpCStr: nil, quality: quality)
                }
            }
        }
    }

    public static func renderSceneLinear(
        rawBytes: Data,
        hint: String,
        xmpPath: URL? = nil,
        quality: Quality = .full
    ) throws -> MapleSceneLinearImageData {
        guard let hintCStr = hint.cString(using: .utf8) else {
            throw PipelineError.hintEncodingError(hint)
        }
        return try RawCoreBridge.withStrippedXMP(xmpPath) { strippedXMP in
            try rawBytes.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
                let base = buf.baseAddress?.assumingMemoryBound(to: UInt8.self)
                if let strippedXMP {
                    return try strippedXMP.withPathCString { xmpCStr in
                        try _renderSceneLinearBytes(
                            ptr: base, len: buf.count,
                            hintCStr: hintCStr, xmpCStr: xmpCStr, quality: quality
                        )
                    }
                } else {
                    return try _renderSceneLinearBytes(
                        ptr: base, len: buf.count,
                        hintCStr: hintCStr, xmpCStr: nil, quality: quality
                    )
                }
            }
        }
    }

    // MARK: Scene-linear sized render (Plan 1 v2 — viewport-sized FFI)

    /// Sized scene-linear render — caps the long edge at `maxLongEdge`,
    /// preserves aspect ratio, never upscales. Per ticket 06 § Technical
    /// Requirements (Swift). Plan 1 v2 — the editor's first Rust-backed
    /// open routes through this when `previewSize` is known. The returned
    /// buffer is Rec.2020 fp16 RGBA at the target dimensions, rotated
    /// per the source RAW's EXIF orientation.
    public static func renderSceneLinearSized(
        rawPath: URL,
        xmpPath: URL? = nil,
        quality: Quality = .preview,
        maxLongEdge: UInt32
    ) throws -> MapleSceneLinearImageData {
        try RawCoreBridge.withStrippedXMP(xmpPath) { strippedXMP in
            try rawPath.withPathCString { rawCStr in
                if let strippedXMP {
                    return try strippedXMP.withPathCString { xmpCStr in
                        try _renderSceneLinearSized(
                            rawCStr: rawCStr, xmpCStr: xmpCStr,
                            quality: quality, maxLongEdge: maxLongEdge
                        )
                    }
                } else {
                    return try _renderSceneLinearSized(
                        rawCStr: rawCStr, xmpCStr: nil,
                        quality: quality, maxLongEdge: maxLongEdge
                    )
                }
            }
        }
    }

    public static func renderSceneLinearSized(
        rawBytes: Data,
        hint: String,
        xmpPath: URL? = nil,
        quality: Quality = .preview,
        maxLongEdge: UInt32
    ) throws -> MapleSceneLinearImageData {
        guard let hintCStr = hint.cString(using: .utf8) else {
            throw PipelineError.hintEncodingError(hint)
        }
        return try RawCoreBridge.withStrippedXMP(xmpPath) { strippedXMP in
            try rawBytes.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
                let base = buf.baseAddress?.assumingMemoryBound(to: UInt8.self)
                if let strippedXMP {
                    return try strippedXMP.withPathCString { xmpCStr in
                        try _renderSceneLinearSizedBytes(
                            ptr: base, len: buf.count, hintCStr: hintCStr,
                            xmpCStr: xmpCStr, quality: quality, maxLongEdge: maxLongEdge
                        )
                    }
                } else {
                    return try _renderSceneLinearSizedBytes(
                        ptr: base, len: buf.count, hintCStr: hintCStr,
                        xmpCStr: nil, quality: quality, maxLongEdge: maxLongEdge
                    )
                }
            }
        }
    }

    // MARK: Private helpers

    private static func _render(rawCStr: UnsafePointer<CChar>,
                                xmpCStr: UnsafePointer<CChar>?,
                                quality: Quality) throws -> MapleImageData {
        var buf = MapleImageBuffer(rgb: nil, len: 0, width: 0, height: 0)
        let rc = maple_render_file(rawCStr, xmpCStr, quality.rawValue, &buf)
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_buffer(&buf) }

        let byteCount = Int(buf.len)
        let data = mapleStage("decode result copy") {
            Data(bytes: buf.rgb!, count: byteCount)
        }
        return MapleImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            pixels: data
        )
    }

    private static func _renderBytes(
        ptr: UnsafePointer<UInt8>?,
        len: Int,
        hintCStr: [CChar],
        xmpCStr: UnsafePointer<CChar>?,
        quality: Quality
    ) throws -> MapleImageData {
        var buf = MapleImageBuffer(rgb: nil, len: 0, width: 0, height: 0)
        let rc = hintCStr.withUnsafeBufferPointer { hintPtr -> Int32 in
            maple_render_bytes(ptr, UInt(len), hintPtr.baseAddress, xmpCStr, quality.rawValue, &buf)
        }
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_buffer(&buf) }

        let byteCount = Int(buf.len)
        guard byteCount > 0, let rgb = buf.rgb else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty buffer")
        }
        let data = mapleStage("decode result copy") {
            Data(bytes: rgb, count: byteCount)
        }
        return MapleImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            pixels: data
        )
    }

    // MARK: Private helpers — scene-linear

    private static func _renderSceneLinear(
        rawCStr: UnsafePointer<CChar>,
        xmpCStr: UnsafePointer<CChar>?,
        quality: Quality
    ) throws -> MapleSceneLinearImageData {
        var buf = MapleSceneLinearBufferF32(
            f32_rgba: nil, len_bytes: 0, channels: 0,
            bytes_per_pixel: 0, width: 0, height: 0
        )
        let rawPath = String(cString: rawCStr)
        let lastSlash = rawPath.lastIndex(of: "/").map { rawPath.index(after: $0) } ?? rawPath.startIndex
        let fileName = String(rawPath[lastSlash...])
        pipelineLog.notice("→ Rust FFI maple_render_file_scene_linear_f32 START: \(fileName, privacy: .public) quality=\(quality.rawValue)")
        let rc = maple_render_file_scene_linear_f32(rawCStr, xmpCStr, quality.rawValue, &buf)
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer_f32(&buf) }
        guard buf.len_bytes > 0, let ptr = buf.f32_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty scene-linear buffer")
        }
        let data = mapleStage("decode result copy") {
            Data(bytes: ptr, count: Int(buf.len_bytes))
        }
        // Sample center pixel of the decoded buffer so we can verify on
        // the user side which pipeline produced this output without
        // having to re-render. f32 RGBA, 16 bytes per pixel.
        let centerOffset = (Int(buf.height) / 2) * Int(buf.width) * 16
                         + (Int(buf.width) / 2) * 16
        var centerR: Float = 0, centerG: Float = 0, centerB: Float = 0
        if data.count >= centerOffset + 12 {
            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                centerR = raw.load(fromByteOffset: centerOffset, as: Float.self)
                centerG = raw.load(fromByteOffset: centerOffset + 4, as: Float.self)
                centerB = raw.load(fromByteOffset: centerOffset + 8, as: Float.self)
            }
        }
        pipelineLog.notice("← Rust FFI maple_render_file_scene_linear_f32 OK: \(buf.width)x\(buf.height) center scene-linear RGB=(\(centerR, format: .fixed(precision: 4)), \(centerG, format: .fixed(precision: 4)), \(centerB, format: .fixed(precision: 4)))")
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data
        )
    }

    private static func _renderSceneLinearBytes(
        ptr: UnsafePointer<UInt8>?,
        len: Int,
        hintCStr: [CChar],
        xmpCStr: UnsafePointer<CChar>?,
        quality: Quality
    ) throws -> MapleSceneLinearImageData {
        var buf = MapleSceneLinearBufferF32(
            f32_rgba: nil, len_bytes: 0, channels: 0,
            bytes_per_pixel: 0, width: 0, height: 0
        )
        let rc = hintCStr.withUnsafeBufferPointer { hintPtr -> Int32 in
            maple_render_bytes_scene_linear_f32(ptr, UInt(len), hintPtr.baseAddress,
                                                xmpCStr, quality.rawValue, &buf)
        }
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer_f32(&buf) }
        guard buf.len_bytes > 0, let bufPtr = buf.f32_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty scene-linear buffer")
        }
        let data = mapleStage("decode result copy") {
            Data(bytes: bufPtr, count: Int(buf.len_bytes))
        }
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data
        )
    }

    // MARK: Private helpers — scene-linear sized

    private static func _renderSceneLinearSized(
        rawCStr: UnsafePointer<CChar>,
        xmpCStr: UnsafePointer<CChar>?,
        quality: Quality,
        maxLongEdge: UInt32
    ) throws -> MapleSceneLinearImageData {
        var buf = MapleSceneLinearBufferF32(
            f32_rgba: nil, len_bytes: 0, channels: 0,
            bytes_per_pixel: 0, width: 0, height: 0
        )
        let rc = maple_render_file_scene_linear_sized_f32(
            rawCStr, xmpCStr, maxLongEdge, quality.rawValue, &buf
        )
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer_f32(&buf) }
        guard buf.len_bytes > 0, let ptr = buf.f32_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty sized buffer")
        }
        let data = mapleStage("decode result copy") {
            Data(bytes: ptr, count: Int(buf.len_bytes))
        }
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data
        )
    }

    private static func _renderSceneLinearSizedBytes(
        ptr: UnsafePointer<UInt8>?,
        len: Int,
        hintCStr: [CChar],
        xmpCStr: UnsafePointer<CChar>?,
        quality: Quality,
        maxLongEdge: UInt32
    ) throws -> MapleSceneLinearImageData {
        var buf = MapleSceneLinearBufferF32(
            f32_rgba: nil, len_bytes: 0, channels: 0,
            bytes_per_pixel: 0, width: 0, height: 0
        )
        let rc = hintCStr.withUnsafeBufferPointer { hintPtr -> Int32 in
            maple_render_bytes_scene_linear_sized_f32(
                ptr, UInt(len), hintPtr.baseAddress,
                xmpCStr, maxLongEdge, quality.rawValue, &buf
            )
        }
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer_f32(&buf) }
        guard buf.len_bytes > 0, let bufPtr = buf.f32_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty sized buffer")
        }
        let data = mapleStage("decode result copy") {
            Data(bytes: bufPtr, count: Int(buf.len_bytes))
        }
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data
        )
    }

    // MARK: - Tile rendering (Plan 3 — Ticket 06 M4)

    /// Open a RAW + optional XMP sidecar into an opaque, Sendable
    /// handle that caches the rawler-decoded mosaic and parsed
    /// adjustment model. Subsequent calls to `renderTile(handle:...)`
    /// against the returned handle skip both the rawler decode and the
    /// XMP parse — the architectural prerequisite for tile-based deep
    /// zoom (Plan 3 Task 5 builds the actor-isolated cache on top of
    /// this).
    ///
    /// The returned `MapleRawHandle` owns the C-allocated state; its
    /// `deinit` calls `maple_close_raw_handle`. Drop the reference (or
    /// let the cache evict it) to release ~30-300 MB of decoded mosaic.
    public static func openRawHandle(
        rawPath: URL,
        xmpPath: URL? = nil
    ) throws -> MapleRawHandle {
        // The handle caches the parsed model, so the strip cost is paid
        // once per open — every subsequent tile render reuses the
        // already-stripped state.
        try RawCoreBridge.withStrippedXMP(xmpPath) { strippedXMP in
            try rawPath.withPathCString { rawCStr in
                if let strippedXMP {
                    return try strippedXMP.withPathCString { xmpCStr in
                        try _openRawHandle(rawCStr: rawCStr, xmpCStr: xmpCStr)
                    }
                } else {
                    return try _openRawHandle(rawCStr: rawCStr, xmpCStr: nil)
                }
            }
        }
    }

    /// Bytes-variant of `openRawHandle` — for sources that don't expose
    /// a filesystem URL (PhotoKit, network-source codepaths). `hint` is
    /// the extension without the leading dot (e.g. `"dng"`).
    public static func openRawHandle(
        rawBytes: Data,
        hint: String,
        xmpPath: URL? = nil
    ) throws -> MapleRawHandle {
        guard let hintCStr = hint.cString(using: .utf8) else {
            throw PipelineError.hintEncodingError(hint)
        }
        return try RawCoreBridge.withStrippedXMP(xmpPath) { strippedXMP in
            try rawBytes.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
                let base = buf.baseAddress?.assumingMemoryBound(to: UInt8.self)
                if let strippedXMP {
                    return try strippedXMP.withPathCString { xmpCStr in
                        try _openRawHandleBytes(
                            ptr: base, len: buf.count,
                            hintCStr: hintCStr, xmpCStr: xmpCStr
                        )
                    }
                } else {
                    return try _openRawHandleBytes(
                        ptr: base, len: buf.count,
                        hintCStr: hintCStr, xmpCStr: nil
                    )
                }
            }
        }
    }

    /// Render a tile against an existing handle. The source rectangle
    /// is in pre-orientation mosaic coordinates; the returned tile is
    /// in oriented full-image coordinate space (matches the unsized
    /// scene-linear FFI's output convention). Output is fp16 RGBA in
    /// Rec.2020 scene-linear, alpha = 1.0.
    ///
    /// Throws `PipelineError.renderFailed`. Notable codes (mirroring the
    /// Rust FFI):
    ///   - 9: bad geometry (any of `srcW`/`srcH`/`outW`/`outH` is 0)
    ///   - 10: dehaze active in the handle's model — tile path unsafe
    ///   - 11: upscale attempt (out > src) — tile path is downscale-only
    ///   - 12: mismatched aspect — `outW/outH` aspect must match
    ///         `srcW/srcH` aspect (the tile path's downsampler is
    ///         long-edge driven, not two-axis)
    public static func renderTile(
        handle: MapleRawHandle,
        srcX: UInt32, srcY: UInt32, srcW: UInt32, srcH: UInt32,
        outW: UInt32, outH: UInt32,
        quality: Quality = .full
    ) throws -> MapleSceneLinearImageData {
        var buf = MapleSceneLinearBuffer(
            fp16_rgba: nil, len_bytes: 0, channels: 0,
            bytes_per_pixel: 0, width: 0, height: 0
        )
        let rc = maple_render_handle_scene_linear_tile(
            handle.pointer,
            srcX, srcY, srcW, srcH,
            outW, outH,
            quality.rawValue,
            &buf
        )
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer(&buf) }
        guard buf.len_bytes > 0, let ptr = buf.fp16_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty tile buffer")
        }
        let data = mapleStage("decode result copy") {
            Data(bytes: ptr, count: Int(buf.len_bytes))
        }
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data
        )
    }

    /// One-shot tile render directly from a RAW file + optional XMP —
    /// no handle lifecycle. Useful for export / one-off tile renders
    /// where the caller doesn't want to keep the decoded mosaic alive.
    /// Internally calls the Task-2 file-based tile FFI so the rawler
    /// decode happens inline.
    public static func renderTile(
        rawPath: URL,
        xmpPath: URL? = nil,
        srcX: UInt32, srcY: UInt32, srcW: UInt32, srcH: UInt32,
        outW: UInt32, outH: UInt32,
        quality: Quality = .full
    ) throws -> MapleSceneLinearImageData {
        try RawCoreBridge.withStrippedXMP(xmpPath) { strippedXMP in
            try rawPath.withPathCString { rawCStr in
                if let strippedXMP {
                    return try strippedXMP.withPathCString { xmpCStr in
                        try _renderFileTile(
                            rawCStr: rawCStr, xmpCStr: xmpCStr,
                            srcX: srcX, srcY: srcY, srcW: srcW, srcH: srcH,
                            outW: outW, outH: outH, quality: quality
                        )
                    }
                } else {
                    return try _renderFileTile(
                        rawCStr: rawCStr, xmpCStr: nil,
                        srcX: srcX, srcY: srcY, srcW: srcW, srcH: srcH,
                        outW: outW, outH: outH, quality: quality
                    )
                }
            }
        }
    }

    /// Bytes-variant of `renderTile(rawPath:...)` — same one-shot
    /// semantics.
    public static func renderTile(
        rawBytes: Data,
        hint: String,
        xmpPath: URL? = nil,
        srcX: UInt32, srcY: UInt32, srcW: UInt32, srcH: UInt32,
        outW: UInt32, outH: UInt32,
        quality: Quality = .full
    ) throws -> MapleSceneLinearImageData {
        guard let hintCStr = hint.cString(using: .utf8) else {
            throw PipelineError.hintEncodingError(hint)
        }
        return try RawCoreBridge.withStrippedXMP(xmpPath) { strippedXMP in
            try rawBytes.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
                let base = buf.baseAddress?.assumingMemoryBound(to: UInt8.self)
                if let strippedXMP {
                    return try strippedXMP.withPathCString { xmpCStr in
                        try _renderBytesTile(
                            ptr: base, len: buf.count,
                            hintCStr: hintCStr, xmpCStr: xmpCStr,
                            srcX: srcX, srcY: srcY, srcW: srcW, srcH: srcH,
                            outW: outW, outH: outH, quality: quality
                        )
                    }
                } else {
                    return try _renderBytesTile(
                        ptr: base, len: buf.count,
                        hintCStr: hintCStr, xmpCStr: nil,
                        srcX: srcX, srcY: srcY, srcW: srcW, srcH: srcH,
                        outW: outW, outH: outH, quality: quality
                    )
                }
            }
        }
    }

    // MARK: Tile private helpers

    private static func _openRawHandle(
        rawCStr: UnsafePointer<CChar>,
        xmpCStr: UnsafePointer<CChar>?
    ) throws -> MapleRawHandle {
        var handlePtr: UnsafeMutablePointer<RawPipeline.MapleRawHandle>? = nil
        let rc = maple_open_raw_handle(rawCStr, xmpCStr, &handlePtr)
        guard rc == 0, let p = handlePtr else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        return MapleRawHandle(pointer: p)
    }

    private static func _openRawHandleBytes(
        ptr: UnsafePointer<UInt8>?,
        len: Int,
        hintCStr: [CChar],
        xmpCStr: UnsafePointer<CChar>?
    ) throws -> MapleRawHandle {
        var handlePtr: UnsafeMutablePointer<RawPipeline.MapleRawHandle>? = nil
        let rc = hintCStr.withUnsafeBufferPointer { hintPtr -> Int32 in
            maple_open_raw_handle_bytes(
                ptr, UInt(len), hintPtr.baseAddress,
                xmpCStr, &handlePtr
            )
        }
        guard rc == 0, let p = handlePtr else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        return MapleRawHandle(pointer: p)
    }

    private static func _renderFileTile(
        rawCStr: UnsafePointer<CChar>,
        xmpCStr: UnsafePointer<CChar>?,
        srcX: UInt32, srcY: UInt32, srcW: UInt32, srcH: UInt32,
        outW: UInt32, outH: UInt32,
        quality: Quality
    ) throws -> MapleSceneLinearImageData {
        var buf = MapleSceneLinearBuffer(
            fp16_rgba: nil, len_bytes: 0, channels: 0,
            bytes_per_pixel: 0, width: 0, height: 0
        )
        let rc = maple_render_file_scene_linear_tile(
            rawCStr, xmpCStr,
            srcX, srcY, srcW, srcH,
            outW, outH,
            quality.rawValue,
            &buf
        )
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer(&buf) }
        guard buf.len_bytes > 0, let ptr = buf.fp16_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty tile buffer")
        }
        let data = mapleStage("decode result copy") {
            Data(bytes: ptr, count: Int(buf.len_bytes))
        }
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data
        )
    }

    private static func _renderBytesTile(
        ptr: UnsafePointer<UInt8>?,
        len: Int,
        hintCStr: [CChar],
        xmpCStr: UnsafePointer<CChar>?,
        srcX: UInt32, srcY: UInt32, srcW: UInt32, srcH: UInt32,
        outW: UInt32, outH: UInt32,
        quality: Quality
    ) throws -> MapleSceneLinearImageData {
        var buf = MapleSceneLinearBuffer(
            fp16_rgba: nil, len_bytes: 0, channels: 0,
            bytes_per_pixel: 0, width: 0, height: 0
        )
        let rc = hintCStr.withUnsafeBufferPointer { hintPtr -> Int32 in
            maple_render_bytes_scene_linear_tile(
                ptr, UInt(len), hintPtr.baseAddress,
                xmpCStr,
                srcX, srcY, srcW, srcH,
                outW, outH,
                quality.rawValue,
                &buf
            )
        }
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer(&buf) }
        guard buf.len_bytes > 0, let bufPtr = buf.fp16_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty tile buffer")
        }
        let data = mapleStage("decode result copy") {
            Data(bytes: bufPtr, count: Int(buf.len_bytes))
        }
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data
        )
    }
}

// MARK: - applySceneLinearChain (per-tick FFI — collapses Metal kernel chain)

extension PipelineRenderer {
    /// Build the C-ABI `MapleAdjustmentParams` from the Swift-side model.
    /// `decodedTemperature/decodedTint` are the WB the cached buffer was
    /// decoded at by the Rust FFI (sidecar `Temperature`/`Tint` when an
    /// XMP was applied, else 6500/0). `skipAgX` flips off the AgX view
    /// transform tail — used by the non-RAW path so we don't double-
    /// tone-map already-display-encoded JPEG / HEIF input.
    public static func makeParams(
        from model: AdjustmentModel,
        decodedTemperature: Double = 6500.0,
        decodedTint: Double = 0.0,
        skipAgX: Bool = false
    ) -> MapleAdjustmentParams {
        // Diagnostic for the magenta-cast investigation: log every value the
        // Apple shell hands to the Rust slider chain. If temperature or tint
        // drift away from defaults (6500 / 0) we know the WB step in the
        // chain runs non-identity, which is what shifts the post-D65 image
        // into a colour cast.
        pipelineLog.notice("makeParams MODEL: temp=\(model.temperature, format: .fixed(precision: 0)) tint=\(model.tint, format: .fixed(precision: 1)) exposure=\(model.exposure, format: .fixed(precision: 2)) contrast=\(model.contrast, format: .fixed(precision: 0)) highlights=\(model.highlights, format: .fixed(precision: 0)) shadows=\(model.shadows, format: .fixed(precision: 0)) whites=\(model.whites, format: .fixed(precision: 0)) blacks=\(model.blacks, format: .fixed(precision: 0)) vib=\(model.vibrance, format: .fixed(precision: 0)) sat=\(model.saturation, format: .fixed(precision: 0)) clarity=\(model.clarity, format: .fixed(precision: 0)) texture=\(model.texture, format: .fixed(precision: 0)) dehaze=\(model.dehaze, format: .fixed(precision: 0)) nr_lum=\(model.nrLuminance, format: .fixed(precision: 0)) | dec_temp=\(decodedTemperature, format: .fixed(precision: 0)) dec_tint=\(decodedTint, format: .fixed(precision: 1)) skip_agx=\(skipAgX)")
        // Per-statement assignment (not a single ~18-arg initializer call):
        // the Swift expression-type-checker hit its complexity ceiling on
        // the literal-init form during xcodebuild after #515 grew the
        // struct to 18 fields. See #565.
        var params = MapleAdjustmentParams()
        params.temperature = Float(model.temperature)
        params.tint = Float(model.tint)
        params.exposure = Float(model.exposure)
        params.contrast = Float(model.contrast)
        params.highlights = Float(model.highlights)
        params.shadows = Float(model.shadows)
        params.whites = Float(model.whites)
        params.blacks = Float(model.blacks)
        params.vibrance = Float(model.vibrance)
        params.saturation = Float(model.saturation)
        params.clarity = Float(model.clarity)
        params.texture = Float(model.texture)
        params.nr_luminance = Float(model.nrLuminance)
        params.dehaze = Float(model.dehaze)
        params.decoded_temperature = Float(decodedTemperature)
        params.decoded_tint = Float(decodedTint)
        params.skip_agx = skipAgX ? 1 : 0
        // L3 (#515) added `look_mode: u8` to the C-ABI struct. Hard-
        // coded to `1` = `Look::Default` here as a syntactic
        // compile-fix — L4 (#509) replaces the literal with
        // `UInt8(model.look.rawValue)` (or equivalent) so the Swift
        // shell actually surfaces the user's Look selection.
        params.look_mode = 1
        return params
    }

    /// Run the Rust per-tick scene-linear chain (white_balance → tone →
    /// vibrance → saturation → clarity → texture → dehaze → nr_luminance
    /// → AgX) over an already-decoded f32 RGBA buffer. Sharpen and
    /// nr_color stay on the Apple GPU path (Metal compute kernels).
    ///
    /// Input data layout: packed f32 RGBA, row-major, 16 bytes/pixel,
    /// `extendedLinearITUR_2020` colourspace, straight alpha.
    ///
    /// Output is the same dimensions / layout, post-AgX
    /// (`DisplayLinearRec2020`, [0,1]) when `params.skip_agx == 0`, or
    /// scene-linear (`SceneLinearRec2020`) when `skip_agx != 0`. Caller
    /// wraps it back into a `CIImage` for the optional sharpen +
    /// nr_color Metal kernels.
    ///
    /// Architectural intent: the per-stage Metal kernel chain on the
    /// Apple side (`MetalKernels.applyWhiteBalance` through
    /// `applyAgXViewTransform`) was a duplicate implementation of the
    /// canonical Rust pipeline. This entry calls the Rust functions
    /// directly so Apple and Rust can never drift on the cheap-stage
    /// chain — see `pipeline::apply_scene_linear_chain_f32` in raw-core.
    ///
    /// Migrated from fp16 to f32 in #487: the fp16 entry silently
    /// round-tripped the scene buffer through 16-bit precision every
    /// slider tick, undoing the f32 storage win of #482. The f32 entry
    /// keeps the working precision intact end-to-end through the chain.
    ///
    /// `inputBytes` must be exactly `16 * width * height` bytes (each
    /// pixel = 4 f32 lanes). Throws on size mismatch or chain failure.
    public static func applySceneLinearChain(
        inputBytes: Data,
        width: Int,
        height: Int,
        params: MapleAdjustmentParams
    ) throws -> Data {
        let lanes = width * height * 4
        let expectedBytes = lanes * MemoryLayout<Float>.size
        guard inputBytes.count == expectedBytes else {
            throw PipelineError.renderFailed(
                code: 9,
                message: "applySceneLinearChain: input \(inputBytes.count) bytes != expected \(expectedBytes)"
            )
        }
        var output = Data(count: expectedBytes)
        let rc = output.withUnsafeMutableBytes { outBuf -> Int32 in
            let outPtr = outBuf.bindMemory(to: Float.self).baseAddress!
            return inputBytes.withUnsafeBytes { inBuf -> Int32 in
                let inPtr = inBuf.bindMemory(to: Float.self).baseAddress!
                var p = params
                return maple_apply_scene_linear_chain_f32(
                    inPtr, UInt32(width), UInt32(height),
                    &p,
                    outPtr
                )
            }
        }
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        return output
    }
}

// MARK: - MapleRawHandle (Swift wrapper around the opaque C handle)

/// Sendable wrapper for the opaque `*mut MapleRawHandle` returned by
/// `maple_open_raw_handle`. Owns the underlying C-allocated state and
/// frees it via `maple_close_raw_handle` exactly once when the last
/// reference drops. `@unchecked Sendable` because the underlying
/// pointer is opaque from Swift's perspective and the caller (typically
/// `RawImageCache` — Plan 3 Task 5) is responsible for serializing
/// access through an actor.
///
/// The Rust side guarantees thread safety for `maple_render_handle_*`
/// calls against a single handle: each call snapshots the inner
/// `RawImage` + `AdjustmentModel` references and runs the development
/// chain on a dedicated worker thread (16 MB stack via
/// `with_large_stack`). The handle's pointee is never mutated after
/// `maple_open_raw_handle` returns, so concurrent reads from multiple
/// threads are safe.
///
/// Cross-link: .archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md
/// Task 4. The C ABI is in
/// src/apple/Frameworks/RawPipeline.xcframework/.../Headers/RawPipeline.h.
public final class MapleRawHandle: @unchecked Sendable {
    /// Pointer to the C-side `MapleRawHandle` struct. Not introspected
    /// from Swift; use the FFI entries to operate on it.
    fileprivate let pointer: UnsafeMutablePointer<RawPipeline.MapleRawHandle>

    fileprivate init(pointer: UnsafeMutablePointer<RawPipeline.MapleRawHandle>) {
        self.pointer = pointer
    }

    deinit {
        // SAFETY: `pointer` came from `maple_open_raw_handle` (or its
        // bytes variant). `maple_close_raw_handle` is a no-op for null
        // pointers and frees the inner allocation exactly once.
        maple_close_raw_handle(pointer)
    }
}

// MARK: - PipelineError

public enum PipelineError: Error, LocalizedError {
    case renderFailed(code: Int, message: String)
    case pathEncodingError(URL)
    case hintEncodingError(String)

    public var errorDescription: String? {
        switch self {
        case .renderFailed(let code, let message):
            return "Pipeline render failed (code \(code)): \(message)"
        case .pathEncodingError(let url):
            return "Path cannot be encoded as UTF-8: \(url.path)"
        case .hintEncodingError(let s):
            return "Decoder hint cannot be encoded as UTF-8: \(s)"
        }
    }
}

// MARK: - URL + path C string helper

private extension URL {
    /// Call `body` with a temporary UTF-8 C string of `path`.
    func withPathCString<R>(_ body: (UnsafePointer<CChar>) throws -> R) throws -> R {
        let p = self.path
        guard let cstr = p.cString(using: .utf8) else {
            throw PipelineError.pathEncodingError(self)
        }
        return try cstr.withUnsafeBufferPointer { ptr in
            try body(ptr.baseAddress!)
        }
    }
}
