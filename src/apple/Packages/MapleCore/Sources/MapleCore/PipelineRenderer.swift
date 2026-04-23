// PipelineRenderer.swift — Swift-safe wrapper around the raw-ffi C API.
//
// FFI surface (from RawPipeline.xcframework / raw-ffi/src/lib.rs):
//
//   int32_t maple_render_file(const char* raw_path,
//                             const char* xmp_path,   // nullable
//                             MapleImageBuffer* out);
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
    public static func render(rawPath: URL, xmpPath: URL? = nil) throws -> MapleImageData {
        try rawPath.withPathCString { rawCStr in
            if let xmpPath {
                return try xmpPath.withPathCString { xmpCStr in
                    try _render(rawCStr: rawCStr, xmpCStr: xmpCStr)
                }
            } else {
                return try _render(rawCStr: rawCStr, xmpCStr: nil)
            }
        }
    }

    // MARK: Private helpers

    private static func _render(rawCStr: UnsafePointer<CChar>,
                                xmpCStr: UnsafePointer<CChar>?) throws -> MapleImageData {
        var buf = MapleImageBuffer(rgb: nil, len: 0, width: 0, height: 0)
        let rc = maple_render_file(rawCStr, xmpCStr, &buf)
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
}

// MARK: - PipelineError

public enum PipelineError: Error, LocalizedError {
    case renderFailed(code: Int, message: String)
    case pathEncodingError(URL)

    public var errorDescription: String? {
        switch self {
        case .renderFailed(let code, let message):
            return "Pipeline render failed (code \(code)): \(message)"
        case .pathEncodingError(let url):
            return "Path cannot be encoded as UTF-8: \(url.path)"
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
