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
import RawPipeline

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

/// Pixel buffer returned by `PipelineRenderer.renderSceneLinear`.
/// Pixels are packed Rec.2020 fp16 RGBA, row-major, 8 bytes per pixel
/// (R G B A as four `Float16` lanes). Straight (non-premultiplied) alpha,
/// always 1.0 in Plan 1.
public struct MapleSceneLinearImageData: Sendable {
    public let width: Int
    public let height: Int
    public let channels: Int            // always 4
    public let bytesPerPixel: Int       // always 8
    /// Packed fp16 RGBA bytes; `pixels.count == 8 * width * height`.
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
    /// docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md.
    public static func renderSceneLinear(
        rawPath: URL,
        xmpPath: URL? = nil,
        quality: Quality = .full
    ) throws -> MapleSceneLinearImageData {
        try rawPath.withPathCString { rawCStr in
            if let xmpPath {
                return try xmpPath.withPathCString { xmpCStr in
                    try _renderSceneLinear(rawCStr: rawCStr, xmpCStr: xmpCStr, quality: quality)
                }
            } else {
                return try _renderSceneLinear(rawCStr: rawCStr, xmpCStr: nil, quality: quality)
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
        return try rawBytes.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            let base = buf.baseAddress?.assumingMemoryBound(to: UInt8.self)
            if let xmpPath {
                return try xmpPath.withPathCString { xmpCStr in
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
        let data = Data(bytes: buf.rgb!, count: byteCount)
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
        let data = Data(bytes: rgb, count: byteCount)
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
        var buf = MapleSceneLinearBuffer(
            fp16_rgba: nil, len_bytes: 0, channels: 0,
            bytes_per_pixel: 0, width: 0, height: 0
        )
        let rc = maple_render_file_scene_linear(rawCStr, xmpCStr, quality.rawValue, &buf)
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer(&buf) }
        guard buf.len_bytes > 0, let ptr = buf.fp16_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty scene-linear buffer")
        }
        let data = Data(bytes: ptr, count: Int(buf.len_bytes))
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
        var buf = MapleSceneLinearBuffer(
            fp16_rgba: nil, len_bytes: 0, channels: 0,
            bytes_per_pixel: 0, width: 0, height: 0
        )
        let rc = hintCStr.withUnsafeBufferPointer { hintPtr -> Int32 in
            maple_render_bytes_scene_linear(ptr, UInt(len), hintPtr.baseAddress,
                                            xmpCStr, quality.rawValue, &buf)
        }
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer(&buf) }
        guard buf.len_bytes > 0, let bufPtr = buf.fp16_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty scene-linear buffer")
        }
        let data = Data(bytes: bufPtr, count: Int(buf.len_bytes))
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data
        )
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
