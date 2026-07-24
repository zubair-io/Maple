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
    /// Per-camera noise profile from `RawImage::noise_profile` (PR #1709
    /// review fix). `nil` when the source DNG carries no NoiseLevelFunction
    /// tag; the per-tick chain falls back to the ISO-only estimate in that
    /// case. Forwarded to `MapleAdjustmentParams.noise_profile_ptr/len` so
    /// `maple_apply_scene_linear_chain_f32` can use it for adaptive NR.
    public let noiseProfile: [Float]?
    /// ISO speed from `RawImage::iso` (PR #1709 review fix). 0 when not
    /// available (the Rust chain substitutes 100 on its side). Forwarded to
    /// `MapleAdjustmentParams.iso`.
    public let iso: UInt32
    /// Decode-exported WB slider frame (#1781) — the calibration frame the
    /// develop chain interpreted the temperature/tint sliders in, plus its
    /// as-shot `(sceneCCT, asShotTint)` estimate. `nil` when the source
    /// carries no frame (fp16 tile path, `RawlerFallback` body, lossy
    /// LinearRaw). Forwarded to the per-tick chains' `wb_frame_*` fields
    /// and to `EditSession`'s As-Shot seeding.
    public let wbFrame: WbSliderFrame?
    /// Decode-exported auto-exposure gain (#1167/#2070) — the scalar the
    /// develop chain applied for `papp:AutoExposure="On"` (1.0 when AE is
    /// off, degenerate, or the source carries no export — the fp16 tile
    /// path, non-RAW). Mirrors `wbFrame`'s export contract but is never
    /// optional: the FFI buffer always carries a value (`1.0` is itself a
    /// meaningful no-op gain, not an absence marker). Forwarded to the
    /// AE-gain-aware tile FFI entry so a deep-zoom / native-detail tile
    /// reproduces the full-image AE brightness instead of omitting the
    /// stage.
    public let aeGain: Float

    public var pixelCount: Int { width * height }

    init(
        width: Int,
        height: Int,
        channels: Int,
        bytesPerPixel: Int,
        pixels: Data,
        noiseProfile: [Float]?,
        iso: UInt32,
        wbFrame: WbSliderFrame? = nil,
        aeGain: Float = 1.0
    ) {
        self.width = width
        self.height = height
        self.channels = channels
        self.bytesPerPixel = bytesPerPixel
        self.pixels = pixels
        self.noiseProfile = noiseProfile
        self.iso = iso
        self.wbFrame = wbFrame
        self.aeGain = aeGain
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

    /// Return code the Rust scene-linear f32 FFI entries use for a render the
    /// host cancelled mid-flight (#951 — `RC_CANCELLED` in
    /// `raw-ffi/src/scene_linear_f32.rs`). Mapped to `PipelineError.cancelled`
    /// so the caller can drop the result on the silent stale path instead of
    /// surfacing a render error. Must stay in lockstep with the Rust constant.
    static let rcCancelled: Int32 = 4

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
    /// minutes. `full` uses bilinear demosaic (legacy value, preserved for ABI
    /// compatibility). `amaze` uses the AMaZE demosaic for highest quality on
    /// Bayer images — this is the export/refine path (#940).
    public enum Quality: Int32 {
        case full = 0
        case preview = 1
        case amaze = 2
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

    // MARK: Histogram (local — bytes source)

    /// Compute a 3×256 RGB histogram of the developed image from in-memory RAW
    /// bytes, mirroring what the Self-Hosted server returns from
    /// `GET /api/assets/:id/histogram` — but entirely on-device, so local
    /// (filesystem) and PhotoKit assets get a real histogram without a server.
    ///
    /// - Parameters:
    ///   - rawBytes: Full RAW file bytes. Copied into the Rust decoder.
    ///   - hint: RAW extension hint without the dot (e.g. `"dng"`). Empty is
    ///           allowed — the decoder falls back to content sniffing.
    ///   - xmpDocument: The XMP sidecar *document text* (not a path) for the
    ///                  adjustments to apply, typically
    ///                  `XMPSerializer.serialize(model:culling:)` so the
    ///                  histogram reflects the live in-memory edit. `nil` uses
    ///                  `AdjustmentModel::default()`.
    ///   - quality: `.preview` (default) runs the half-res demosaic — a
    ///              histogram is a statistical reduction, so it is visually
    ///              identical and ~4× cheaper than `.full`, which keeps the
    ///              on-edit-settle recompute light.
    /// - Returns: The unnormalised RGB counts (same shape as `CloudHistogram`).
    /// - Throws: `PipelineError` on a non-zero FFI status.
    public static func histogram(
        rawBytes: Data,
        hint: String,
        xmpDocument: String?,
        quality: Quality = .preview
    ) throws -> CloudHistogram {
        guard let hintCStr = hint.cString(using: .utf8) else {
            throw PipelineError.hintEncodingError(hint)
        }
        // `[UInt32]` storage is u32-aligned, which the FFI requires for the
        // `from_raw_parts_mut` write on the Rust side.
        var bins = [UInt32](repeating: 0, count: 768)
        let xmpCChars: [CChar]? = xmpDocument?.cString(using: .utf8)
        let rc: Int32 = rawBytes.withUnsafeBytes { (buf: UnsafeRawBufferPointer) -> Int32 in
            let base = buf.baseAddress?.assumingMemoryBound(to: UInt8.self)
            return hintCStr.withUnsafeBufferPointer { hintPtr -> Int32 in
                bins.withUnsafeMutableBufferPointer { binsPtr -> Int32 in
                    let binsBase = binsPtr.baseAddress      // capture the pointer value, not the inout `binsPtr`
                    let call: (UnsafePointer<CChar>?) -> Int32 = { xmpPtr in
                        maple_histogram_bytes(
                            base, UInt(buf.count), hintPtr.baseAddress, xmpPtr,
                            quality.rawValue, binsBase
                        )
                    }
                    if let xmpCChars {
                        return xmpCChars.withUnsafeBufferPointer { call($0.baseAddress) }
                    } else {
                        return call(nil)
                    }
                }
            }
        }
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        return CloudHistogram(
            r: bins[0..<256].map(Int.init),
            g: bins[256..<512].map(Int.init),
            b: bins[512..<768].map(Int.init)
        )
    }

    // MARK: Scene-linear render (Plan 1 FFI split)

    /// Render a RAW file to a Rec.2020 fp16 RGBA scene-linear buffer.
    /// The Apple consumer is expected to import the buffer as a CIImage
    /// tagged `CGColorSpace.extendedLinearITUR_2020` and apply a view
    /// transform (AgX) + gamut convert (Rec.2020 → sRGB) downstream.
    ///
    /// Plan 1 wire — see
    /// .archived-plans/plans/2026-04-24-ffi-split-plan-1.md.
    /// `cancel` (#951) is an optional cooperative cancellation flag. When the
    /// host flips it mid-render, the Rust develop chain unwinds inside the
    /// expensive stages and this throws `PipelineError.cancelled`. Pass `nil`
    /// for the legacy never-cancel behaviour (bit-identical output). The caller
    /// must keep the `CancelFlag` alive for the whole call (it holds the Rust
    /// allocation the worker reads).
    public static func renderSceneLinear(
        rawPath: URL,
        xmpPath: URL? = nil,
        quality: Quality = .full,
        profileOverride: Profile? = nil,
        autoExposureOverride: AutoExposureMode? = nil,
        cancel: CancelFlag? = nil
    ) throws -> MapleSceneLinearImageData {
        // Apple-GPU strip lives in Swift (ticket #124). The temp XMP
        // carries only the fields the Rust decode should bake; the
        // Metal chain re-applies the rest at the slider tick.
        // `profileOverride` (#871) forces the LIVE profile into the temp
        // XMP so the decode's auto-exposure-Off-when-Auto decision tracks
        // the user's current selection, not the debounced sidecar.
        // `autoExposureOverride` (#1387) mirrors that for `auto_exposure`
        // itself — see `RawCoreBridge.applyOverrides`.
        try RawCoreBridge.withStrippedXMP(
            xmpPath, profileOverride: profileOverride, autoExposureOverride: autoExposureOverride
        ) { strippedXMP in
            try rawPath.withPathCString { rawCStr in
                if let strippedXMP {
                    return try strippedXMP.withPathCString { xmpCStr in
                        try _renderSceneLinear(rawCStr: rawCStr, xmpCStr: xmpCStr, quality: quality, cancel: cancel)
                    }
                } else {
                    return try _renderSceneLinear(rawCStr: rawCStr, xmpCStr: nil, quality: quality, cancel: cancel)
                }
            }
        }
    }

    public static func renderSceneLinear(
        rawBytes: Data,
        hint: String,
        xmpPath: URL? = nil,
        quality: Quality = .full,
        profileOverride: Profile? = nil,
        autoExposureOverride: AutoExposureMode? = nil,
        cancel: CancelFlag? = nil
    ) throws -> MapleSceneLinearImageData {
        guard let hintCStr = hint.cString(using: .utf8) else {
            throw PipelineError.hintEncodingError(hint)
        }
        return try RawCoreBridge.withStrippedXMP(
            xmpPath, profileOverride: profileOverride, autoExposureOverride: autoExposureOverride
        ) { strippedXMP in
            try rawBytes.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
                let base = buf.baseAddress?.assumingMemoryBound(to: UInt8.self)
                if let strippedXMP {
                    return try strippedXMP.withPathCString { xmpCStr in
                        try _renderSceneLinearBytes(
                            ptr: base, len: buf.count,
                            hintCStr: hintCStr, xmpCStr: xmpCStr, quality: quality, cancel: cancel
                        )
                    }
                } else {
                    return try _renderSceneLinearBytes(
                        ptr: base, len: buf.count,
                        hintCStr: hintCStr, xmpCStr: nil, quality: quality, cancel: cancel
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
        maxLongEdge: UInt32,
        profileOverride: Profile? = nil,
        autoExposureOverride: AutoExposureMode? = nil,
        cancel: CancelFlag? = nil
    ) throws -> MapleSceneLinearImageData {
        try RawCoreBridge.withStrippedXMP(
            xmpPath, profileOverride: profileOverride, autoExposureOverride: autoExposureOverride
        ) { strippedXMP in
            try rawPath.withPathCString { rawCStr in
                if let strippedXMP {
                    return try strippedXMP.withPathCString { xmpCStr in
                        try _renderSceneLinearSized(
                            rawCStr: rawCStr, xmpCStr: xmpCStr,
                            quality: quality, maxLongEdge: maxLongEdge, cancel: cancel
                        )
                    }
                } else {
                    return try _renderSceneLinearSized(
                        rawCStr: rawCStr, xmpCStr: nil,
                        quality: quality, maxLongEdge: maxLongEdge, cancel: cancel
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
        maxLongEdge: UInt32,
        profileOverride: Profile? = nil,
        autoExposureOverride: AutoExposureMode? = nil,
        cancel: CancelFlag? = nil
    ) throws -> MapleSceneLinearImageData {
        guard let hintCStr = hint.cString(using: .utf8) else {
            throw PipelineError.hintEncodingError(hint)
        }
        return try RawCoreBridge.withStrippedXMP(
            xmpPath, profileOverride: profileOverride, autoExposureOverride: autoExposureOverride
        ) { strippedXMP in
            try rawBytes.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
                let base = buf.baseAddress?.assumingMemoryBound(to: UInt8.self)
                if let strippedXMP {
                    return try strippedXMP.withPathCString { xmpCStr in
                        try _renderSceneLinearSizedBytes(
                            ptr: base, len: buf.count, hintCStr: hintCStr,
                            xmpCStr: xmpCStr, quality: quality, maxLongEdge: maxLongEdge, cancel: cancel
                        )
                    }
                } else {
                    return try _renderSceneLinearSizedBytes(
                        ptr: base, len: buf.count, hintCStr: hintCStr,
                        xmpCStr: nil, quality: quality, maxLongEdge: maxLongEdge, cancel: cancel
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
        quality: Quality,
        cancel: CancelFlag?
    ) throws -> MapleSceneLinearImageData {
        // Zero-filled by the imported C struct's implicit init — includes the
        // #1781 `wb_frame_*` tail (absent until the FFI writes a frame).
        var buf = MapleSceneLinearBufferF32()
        let rawPath = String(cString: rawCStr)
        let lastSlash = rawPath.lastIndex(of: "/").map { rawPath.index(after: $0) } ?? rawPath.startIndex
        let fileName = String(rawPath[lastSlash...])
        pipelineLog.notice("→ Rust FFI maple_render_file_scene_linear_f32 START: \(fileName, privacy: .public) quality=\(quality.rawValue)")
        // Derive the raw cancel pointer from the live `CancelFlag` AT the call
        // site (#951). `cancel` is held strongly by the caller across this
        // synchronous FFI call, so the Rust worker that reads the pointer never
        // sees freed memory. `nil` ⇒ null ⇒ never-cancel.
        let rc = maple_render_file_scene_linear_f32(rawCStr, xmpCStr, quality.rawValue, cancel?.pointer, &buf)
        if rc == Self.rcCancelled {
            throw PipelineError.cancelled
        }
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
        // Extract noise profile before defer frees the buffer (PR #1709 fix).
        let noiseProfile: [Float]? = {
            guard buf.noise_profile_len > 0, let npPtr = buf.noise_profile_data else { return nil }
            return Array(UnsafeBufferPointer(start: npPtr, count: Int(buf.noise_profile_len)))
        }()
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data,
            noiseProfile: noiseProfile,
            iso: buf.iso,
            wbFrame: WbSliderFrame(buffer: buf),
            aeGain: buf.ae_gain
        )
    }

    private static func _renderSceneLinearBytes(
        ptr: UnsafePointer<UInt8>?,
        len: Int,
        hintCStr: [CChar],
        xmpCStr: UnsafePointer<CChar>?,
        quality: Quality,
        cancel: CancelFlag?
    ) throws -> MapleSceneLinearImageData {
        // Zero-filled by the imported C struct's implicit init — includes the
        // #1781 `wb_frame_*` tail (absent until the FFI writes a frame).
        var buf = MapleSceneLinearBufferF32()
        let rc = hintCStr.withUnsafeBufferPointer { hintPtr -> Int32 in
            maple_render_bytes_scene_linear_f32(ptr, UInt(len), hintPtr.baseAddress,
                                                xmpCStr, quality.rawValue, cancel?.pointer, &buf)
        }
        if rc == Self.rcCancelled {
            throw PipelineError.cancelled
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
        // Extract noise profile before defer frees the buffer (PR #1709 fix).
        let noiseProfile: [Float]? = {
            guard buf.noise_profile_len > 0, let npPtr = buf.noise_profile_data else { return nil }
            return Array(UnsafeBufferPointer(start: npPtr, count: Int(buf.noise_profile_len)))
        }()
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data,
            noiseProfile: noiseProfile,
            iso: buf.iso,
            wbFrame: WbSliderFrame(buffer: buf),
            aeGain: buf.ae_gain
        )
    }

    // MARK: Private helpers — scene-linear sized

    private static func _renderSceneLinearSized(
        rawCStr: UnsafePointer<CChar>,
        xmpCStr: UnsafePointer<CChar>?,
        quality: Quality,
        maxLongEdge: UInt32,
        cancel: CancelFlag?
    ) throws -> MapleSceneLinearImageData {
        // Zero-filled by the imported C struct's implicit init — includes the
        // #1781 `wb_frame_*` tail (absent until the FFI writes a frame).
        var buf = MapleSceneLinearBufferF32()
        let rc = maple_render_file_scene_linear_sized_f32(
            rawCStr, xmpCStr, maxLongEdge, quality.rawValue, cancel?.pointer, &buf
        )
        if rc == Self.rcCancelled {
            throw PipelineError.cancelled
        }
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
        // Extract noise profile before defer frees the buffer (PR #1709 fix).
        let noiseProfile: [Float]? = {
            guard buf.noise_profile_len > 0, let npPtr = buf.noise_profile_data else { return nil }
            return Array(UnsafeBufferPointer(start: npPtr, count: Int(buf.noise_profile_len)))
        }()
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data,
            noiseProfile: noiseProfile,
            iso: buf.iso,
            wbFrame: WbSliderFrame(buffer: buf),
            aeGain: buf.ae_gain
        )
    }

    private static func _renderSceneLinearSizedBytes(
        ptr: UnsafePointer<UInt8>?,
        len: Int,
        hintCStr: [CChar],
        xmpCStr: UnsafePointer<CChar>?,
        quality: Quality,
        maxLongEdge: UInt32,
        cancel: CancelFlag?
    ) throws -> MapleSceneLinearImageData {
        // Zero-filled by the imported C struct's implicit init — includes the
        // #1781 `wb_frame_*` tail (absent until the FFI writes a frame).
        var buf = MapleSceneLinearBufferF32()
        let rc = hintCStr.withUnsafeBufferPointer { hintPtr -> Int32 in
            maple_render_bytes_scene_linear_sized_f32(
                ptr, UInt(len), hintPtr.baseAddress,
                xmpCStr, maxLongEdge, quality.rawValue, cancel?.pointer, &buf
            )
        }
        if rc == Self.rcCancelled {
            throw PipelineError.cancelled
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
        // Extract noise profile before defer frees the buffer (PR #1709 fix).
        let noiseProfile: [Float]? = {
            guard buf.noise_profile_len > 0, let npPtr = buf.noise_profile_data else { return nil }
            return Array(UnsafeBufferPointer(start: npPtr, count: Int(buf.noise_profile_len)))
        }()
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data,
            noiseProfile: noiseProfile,
            iso: buf.iso,
            wbFrame: WbSliderFrame(buffer: buf),
            aeGain: buf.ae_gain
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

    /// Open a RAW handle from the live in-memory adjustment model. The model
    /// is stripped to the decode-baked fields before serialization, matching
    /// the whole-image Apple decode contract without waiting for the
    /// debounced XMP sidecar write to land.
    public static func openRawHandle(
        rawPath: URL,
        model: AdjustmentModel,
        profileOverride: Profile? = nil,
        autoExposureOverride: AutoExposureMode? = nil
    ) throws -> MapleRawHandle {
        try RawCoreBridge.withStrippedModelXMP(
            model,
            profileOverride: profileOverride,
            autoExposureOverride: autoExposureOverride
        ) { strippedXMP in
            try rawPath.withPathCString { rawCStr in
                if let strippedXMP {
                    return try strippedXMP.withPathCString { xmpCStr in
                        try _openRawHandle(rawCStr: rawCStr, xmpCStr: xmpCStr)
                    }
                }
                return try _openRawHandle(rawCStr: rawCStr, xmpCStr: nil)
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
    /// is in display-oriented full-image coordinates; the Rust tile entry
    /// maps it into sensor axes and applies EXIF orientation internally.
    /// The returned tile is in the same oriented coordinate space (matching
    /// the unsized scene-linear FFI's output convention). Output is fp16 RGBA in
    /// Rec.2020 scene-linear, alpha = 1.0.
    ///
    /// Throws `PipelineError.renderFailed`. Notable codes (mirroring the
    /// Rust FFI):
    ///   - 9: bad geometry (any of `srcW`/`srcH`/`outW`/`outH` is 0)
    ///   - 10: model not tile-compatible (dehaze, vignette, deep denoise,
    ///         a non-identity local adjustment, or capture sharpening active — #1084 /
    ///         #1105 / #1109); fall back to the non-tile refine
    ///   - 11: upscale attempt (out > src) — tile path is downscale-only
    ///   - 12: mismatched aspect — `outW/outH` aspect must match
    ///         `srcW/srcH` aspect (the tile path's downsampler is
    ///         long-edge driven, not two-axis)
    ///
    /// `decodedTemperature`/`decodedTint` (#1725 band fix): when both are
    /// non-nil, the tile's WB stage applies `model.temperature`/`model.tint`
    /// as a DELTA vs. `(decodedTemperature, decodedTint)` — the same
    /// contract `applySceneLinearChainViaFFI`'s `decodedTemperature`/
    /// `decodedTint` use — so a tile rendered at `model.temperature ==
    /// decodedTemperature` is IDENTITY, matching an unedited-open live
    /// frame instead of shifting away from it. `nil` (the default) sends
    /// the `0.0`/`0.0` sentinel, preserving the legacy ABSOLUTE `resolve_wb`
    /// + `apply` behavior — correct for handles opened with `xmpPath: nil`
    /// (the current deep-zoom `RawImageCache`/`TileManager` callers, which
    /// carry no edits, so ABSOLUTE and DELTA already agree at the default
    /// model).
    public static func renderTile(
        handle: MapleRawHandle,
        srcX: UInt32, srcY: UInt32, srcW: UInt32, srcH: UInt32,
        outW: UInt32, outH: UInt32,
        quality: Quality = .full,
        decodedTemperature: Double? = nil,
        decodedTint: Double? = nil
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
            // 0.0 is the FFI sentinel for "no decoded WB anchor" (the C side
            // treats `decoded_temperature > 0.0` as "use it"; Kelvin bottoms
            // out at 2000, so 0.0 is safely out of range).
            Float(decodedTemperature ?? 0.0),
            Float(decodedTint ?? 0.0),
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
        // fp16 tile path — MapleSceneLinearBuffer carries no noise profile.
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data,
            noiseProfile: nil,
            iso: 0
        )
    }

    /// f32 (16 B/px) counterpart to `renderTile(handle:...)`. The
    /// native-detail tile-refinement path (`NativeDetailRenderer`) uses this
    /// so its working precision matches the whole-image scene-linear path's
    /// f32 (`ImageEditPipeline`, #487) instead of the fp16 the tile path
    /// shipped — a precision-tier divergence that could bias shadows / band
    /// the AgX shoulder in the zoomed-in tile vs the full image (#1945). Same
    /// #1725 WB delta-anchor contract as the fp16 overload.
    public static func renderTileF32(
        handle: MapleRawHandle,
        srcX: UInt32, srcY: UInt32, srcW: UInt32, srcH: UInt32,
        outW: UInt32, outH: UInt32,
        quality: Quality = .full,
        decodedTemperature: Double? = nil,
        decodedTint: Double? = nil
    ) throws -> MapleSceneLinearImageData {
        var buf = MapleSceneLinearBufferF32()
        let rc = maple_render_handle_scene_linear_tile_f32(
            handle.pointer,
            srcX, srcY, srcW, srcH,
            outW, outH,
            quality.rawValue,
            // 0.0 is the FFI sentinel for "no decoded WB anchor" (see the
            // fp16 overload).
            Float(decodedTemperature ?? 0.0),
            Float(decodedTint ?? 0.0),
            &buf
        )
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer_f32(&buf) }
        guard buf.len_bytes > 0, let ptr = buf.f32_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty tile buffer")
        }
        let data = mapleStage("decode tile f32 result copy") {
            Data(bytes: ptr, count: Int(buf.len_bytes))
        }
        // Tile refinement ignores the buffer's noise/wb-frame fields (it only
        // builds a display CIImage); expose just the pixels + geometry.
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data,
            noiseProfile: nil,
            iso: 0
        )
    }

    /// AE-gain-aware sibling of `renderTileF32` (#1167/#2070). Binds the new
    /// `maple_render_handle_scene_linear_tile_ae_f32` FFI entry — a distinct
    /// symbol from `maple_render_handle_scene_linear_tile_f32` (kept intact
    /// above) rather than a widened arity, so any caller still compiled
    /// against the old signature keeps working unchanged.
    ///
    /// `aeGain` is the full-image (or sized) decode's exported
    /// `MapleSceneLinearImageData.aeGain` for the SAME model — threading it
    /// through makes a deep-zoom / native-detail tile reproduce the
    /// full-image auto-exposure brightness instead of omitting the stage.
    /// `aeGain == 1.0` reproduces `renderTileF32`'s output bit-for-bit (the
    /// Rust FFI's documented no-op case — Auto-profile buffers, whose decode
    /// contract disables AE, always export `1.0` here, so this is a no-op
    /// for Auto and only changes output for Neutral/ACR-Match). Same #1725
    /// WB delta-anchor contract as the other tile overloads.
    public static func renderTileF32(
        handle: MapleRawHandle,
        srcX: UInt32, srcY: UInt32, srcW: UInt32, srcH: UInt32,
        outW: UInt32, outH: UInt32,
        quality: Quality = .full,
        decodedTemperature: Double? = nil,
        decodedTint: Double? = nil,
        aeGain: Float
    ) throws -> MapleSceneLinearImageData {
        var buf = MapleSceneLinearBufferF32()
        let rc = maple_render_handle_scene_linear_tile_ae_f32(
            handle.pointer,
            srcX, srcY, srcW, srcH,
            outW, outH,
            quality.rawValue,
            // 0.0 is the FFI sentinel for "no decoded WB anchor" (see the
            // fp16 overload).
            Float(decodedTemperature ?? 0.0),
            Float(decodedTint ?? 0.0),
            aeGain,
            &buf
        )
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer_f32(&buf) }
        guard buf.len_bytes > 0, let ptr = buf.f32_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty tile buffer")
        }
        let data = mapleStage("decode tile ae f32 result copy") {
            Data(bytes: ptr, count: Int(buf.len_bytes))
        }
        // Tile refinement ignores the buffer's noise/wb-frame fields (it only
        // builds a display CIImage); expose just the pixels + geometry.
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data,
            noiseProfile: nil,
            iso: 0
        )
    }

    /// One-shot tile render directly from a RAW file + optional XMP —
    /// no handle lifecycle. Useful for export / one-off tile renders
    /// where the caller doesn't want to keep the decoded mosaic alive.
    /// Internally calls the Task-2 file-based tile FFI so the rawler
    /// decode happens inline.
    ///
    /// `decodedTemperature`/`decodedTint`: same #1725 delta-anchor contract
    /// as `renderTile(handle:...)` — see that overload's doc comment.
    public static func renderTile(
        rawPath: URL,
        xmpPath: URL? = nil,
        srcX: UInt32, srcY: UInt32, srcW: UInt32, srcH: UInt32,
        outW: UInt32, outH: UInt32,
        quality: Quality = .full,
        decodedTemperature: Double? = nil,
        decodedTint: Double? = nil
    ) throws -> MapleSceneLinearImageData {
        try RawCoreBridge.withStrippedXMP(xmpPath) { strippedXMP in
            try rawPath.withPathCString { rawCStr in
                if let strippedXMP {
                    return try strippedXMP.withPathCString { xmpCStr in
                        try _renderFileTile(
                            rawCStr: rawCStr, xmpCStr: xmpCStr,
                            srcX: srcX, srcY: srcY, srcW: srcW, srcH: srcH,
                            outW: outW, outH: outH, quality: quality,
                            decodedTemperature: decodedTemperature, decodedTint: decodedTint
                        )
                    }
                } else {
                    return try _renderFileTile(
                        rawCStr: rawCStr, xmpCStr: nil,
                        srcX: srcX, srcY: srcY, srcW: srcW, srcH: srcH,
                        outW: outW, outH: outH, quality: quality,
                        decodedTemperature: decodedTemperature, decodedTint: decodedTint
                    )
                }
            }
        }
    }

    /// Bytes-variant of `renderTile(rawPath:...)` — same one-shot
    /// semantics. `decodedTemperature`/`decodedTint`: same #1725
    /// delta-anchor contract as `renderTile(handle:...)`.
    public static func renderTile(
        rawBytes: Data,
        hint: String,
        xmpPath: URL? = nil,
        srcX: UInt32, srcY: UInt32, srcW: UInt32, srcH: UInt32,
        outW: UInt32, outH: UInt32,
        quality: Quality = .full,
        decodedTemperature: Double? = nil,
        decodedTint: Double? = nil
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
                            outW: outW, outH: outH, quality: quality,
                            decodedTemperature: decodedTemperature, decodedTint: decodedTint
                        )
                    }
                } else {
                    return try _renderBytesTile(
                        ptr: base, len: buf.count,
                        hintCStr: hintCStr, xmpCStr: nil,
                        srcX: srcX, srcY: srcY, srcW: srcW, srcH: srcH,
                        outW: outW, outH: outH, quality: quality,
                        decodedTemperature: decodedTemperature, decodedTint: decodedTint
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
        quality: Quality,
        decodedTemperature: Double? = nil,
        decodedTint: Double? = nil
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
            Float(decodedTemperature ?? 0.0),
            Float(decodedTint ?? 0.0),
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
        // fp16 tile path — MapleSceneLinearBuffer carries no noise profile.
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data,
            noiseProfile: nil,
            iso: 0
        )
    }

    private static func _renderBytesTile(
        ptr: UnsafePointer<UInt8>?,
        len: Int,
        hintCStr: [CChar],
        xmpCStr: UnsafePointer<CChar>?,
        srcX: UInt32, srcY: UInt32, srcW: UInt32, srcH: UInt32,
        outW: UInt32, outH: UInt32,
        quality: Quality,
        decodedTemperature: Double? = nil,
        decodedTint: Double? = nil
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
                Float(decodedTemperature ?? 0.0),
                Float(decodedTint ?? 0.0),
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
        // fp16 tile path — MapleSceneLinearBuffer carries no noise profile.
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data,
            noiseProfile: nil,
            iso: 0
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
    /// `wbFrame` (#1781): the decode-exported WB slider frame. When present
    /// the Rust chain derives its WB delta in that frame (the same math the
    /// full develop uses); `nil` leaves the `wb_frame_*` tail zeroed — the
    /// legacy generic-CAT16 delta, bit-identical to pre-#1781.
    public static func makeParams(
        from model: AdjustmentModel,
        decodedTemperature: Double = 6500.0,
        decodedTint: Double = 0.0,
        skipAgX: Bool = false,
        iso: UInt32 = 0,
        wbFrame: WbSliderFrame? = nil
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
        // L3 (#515) added `look_mode: u8` to the C-ABI struct. Surface the
        // user's real Look selection (#812 removed the hard-coded `1`) so
        // the FFI chain reconstructs `Look::from(look_mode)` rather than a
        // literal. Note the f32 scene-linear chain stops at AgX and does
        // not itself apply the DisplayLookCurve — the empirical Look LUT
        // is superseded by Auto Profile (`Profile::Auto`), which the Apple
        // canvas applies via a post-encode CIColorCube (see
        // `ImageEditPipeline.processSceneLinear` + `AutoProfileLUT`).
        params.look_mode = model.look.lookMode
        // Brightness (#1102) — midtone-band gain, appended at the struct
        // tail per the look_mode ABI convention. 0 = identity.
        params.brightness = Float(model.brightness)
        // Vignette (#1109) — radial gain, appended at the struct tail per
        // the same convention. Amount 0 = identity (feather inert).
        params.vignette_amount = Float(model.vignetteAmount)
        params.vignette_feather = Float(model.vignetteFeather)
        // Film grain (#1110) — display-linear noise, appended at the
        // struct tail. Amount 0 = identity (size / roughness inert).
        params.grain_amount = Float(model.grainAmount)
        params.grain_size = Float(model.grainSize)
        params.grain_roughness = Float(model.grainRoughness)
        // Split toning (#1111) — display-linear Oklab tint, appended at
        // the struct tail. Zero saturations = identity (hues / balance
        // inert).
        params.split_tone_shadow_hue = Float(model.splitToneShadowHue)
        params.split_tone_shadow_saturation = Float(model.splitToneShadowSaturation)
        params.split_tone_highlight_hue = Float(model.splitToneHighlightHue)
        params.split_tone_highlight_saturation = Float(model.splitToneHighlightSaturation)
        params.split_tone_balance = Float(model.splitToneBalance)
        // HSL 8-band adjustments (#1112)
        params.hsl_hue_red      = Float(model.hueAdjustmentRed)
        params.hsl_hue_orange   = Float(model.hueAdjustmentOrange)
        params.hsl_hue_yellow   = Float(model.hueAdjustmentYellow)
        params.hsl_hue_green    = Float(model.hueAdjustmentGreen)
        params.hsl_hue_aqua     = Float(model.hueAdjustmentAqua)
        params.hsl_hue_blue     = Float(model.hueAdjustmentBlue)
        params.hsl_hue_purple   = Float(model.hueAdjustmentPurple)
        params.hsl_hue_magenta  = Float(model.hueAdjustmentMagenta)
        params.hsl_sat_red      = Float(model.saturationAdjustmentRed)
        params.hsl_sat_orange   = Float(model.saturationAdjustmentOrange)
        params.hsl_sat_yellow   = Float(model.saturationAdjustmentYellow)
        params.hsl_sat_green    = Float(model.saturationAdjustmentGreen)
        params.hsl_sat_aqua     = Float(model.saturationAdjustmentAqua)
        params.hsl_sat_blue     = Float(model.saturationAdjustmentBlue)
        params.hsl_sat_purple   = Float(model.saturationAdjustmentPurple)
        params.hsl_sat_magenta  = Float(model.saturationAdjustmentMagenta)
        params.hsl_lum_red      = Float(model.luminanceAdjustmentRed)
        params.hsl_lum_orange   = Float(model.luminanceAdjustmentOrange)
        params.hsl_lum_yellow   = Float(model.luminanceAdjustmentYellow)
        params.hsl_lum_green    = Float(model.luminanceAdjustmentGreen)
        params.hsl_lum_aqua     = Float(model.luminanceAdjustmentAqua)
        params.hsl_lum_blue     = Float(model.luminanceAdjustmentBlue)
        params.hsl_lum_purple   = Float(model.luminanceAdjustmentPurple)
        params.hsl_lum_magenta  = Float(model.luminanceAdjustmentMagenta)
        // Target display primaries (#1337): 0 = sRGB (legacy-compatible default).
        // Phase 2 (#1338) will set this from the user-facing settings toggle.
        params.target_primaries = 0
        // Input shape (#1331): the CPU chain (MapleAdjustmentParams) uses `input_shape`
        // only for the WB-identity collapse; the AgX skip is `skip_agx`, not this field.
        // 0 = PostDcpRec2020Fp16 (RAW path) — both RAW and non-RAW callers leave it 0
        // here because the non-RAW CPU path already handles WB via `decodedTemperature`.
        params.input_shape = 0
        // Noise profile (PR #1709 review finding): noise_profile_ptr / noise_profile_len
        // carry a pointer into a caller-owned [Float] buffer and MUST NOT outlive that
        // buffer. They are left zero here (null / 0) so `MapleAdjustmentParams` is safe
        // to copy and store. The actual pointer is set on the local `var p` copy inside
        // `applySceneLinearChain` via `withUnsafeBufferPointer`, scoped to the FFI call.
        params.noise_profile_ptr = nil
        params.noise_profile_len = 0
        // ISO speed (PR #1709): 0 = unknown; Rust side maps 0 → 100 as a safe default.
        params.iso = iso
        // WB slider frame (#1781) — appended at the struct tail; absent
        // (`nil`, or a frame that reads !isPresent) leaves the zero-filled
        // legacy state.
        if let wbFrame, wbFrame.isPresent {
            wbFrame.fill(&params)
        }
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
        params: MapleAdjustmentParams,
        noiseProfile: [Float]? = nil
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
        // `noiseProfile` must outlive the FFI call. Pin it via
        // `withUnsafeBufferPointer` so the closure captures the live pointer;
        // the outer closure chain keeps `noiseProfile` alive for the duration.
        let rc: Int32 = try withOptionalUnsafeBufferPointer(noiseProfile) { npBuf in
            var p = params
            if let npBuf {
                p.noise_profile_ptr = npBuf.baseAddress
                p.noise_profile_len = UInt32(npBuf.count)
            }
            return try output.withUnsafeMutableBytes { outBuf -> Int32 in
                let outPtr = outBuf.bindMemory(to: Float.self).baseAddress!
                return inputBytes.withUnsafeBytes { inBuf -> Int32 in
                    let inPtr = inBuf.bindMemory(to: Float.self).baseAddress!
                    return maple_apply_scene_linear_chain_f32(
                        inPtr, UInt32(width), UInt32(height),
                        &p,
                        outPtr
                    )
                }
            }
        }
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        return output
    }

    /// Helper: invoke `body` with an `UnsafeBufferPointer<T>?` scoped to
    /// the lifetime of `array`. Passes `nil` when `array` is nil.
    private static func withOptionalUnsafeBufferPointer<T, R>(
        _ array: [T]?,
        body: (UnsafeBufferPointer<T>?) throws -> R
    ) rethrows -> R {
        guard let array else { return try body(nil) }
        return try array.withUnsafeBufferPointer { try body($0) }
    }

    /// Apply raw-core's canonical display **encode** to a post-AgX
    /// **display-linear Rec.2020** f32 RGBA buffer: hue-preserving Oklab
    /// gamut compression (`rec2020_to_srgb`, #438) + `srgb_gamma_encode`.
    /// Returns **sRGB-gamma-encoded sRGB-primary** f32 RGBA at the same
    /// dimensions / layout (16 bytes/pixel, straight alpha).
    ///
    /// This is the #877 fix: the Apple canvas previously reached sRGB
    /// implicitly at the CoreImage `createCGImage` boundary, which clamps
    /// the Rec.2020→sRGB matrix output per-channel rather than performing
    /// the Oklab chroma compression the CPU/CLI reference uses — so
    /// saturated wide-gamut greens clipped and diverged (#871). Running
    /// this entry as the explicit encode (then tagging the result sRGB)
    /// makes the canvas gamut-correct by construction, and lands the buffer
    /// in the sRGB-gamma-encoded sRGB-primary space the Auto Profile cube
    /// was fit/baked in.
    ///
    /// `inputBytes` must be exactly `16 * width * height` bytes. Throws on
    /// size mismatch or FFI failure.
    public static func encodeDisplaySRGB(
        inputBytes: Data,
        width: Int,
        height: Int
    ) throws -> Data {
        let lanes = width * height * 4
        let expectedBytes = lanes * MemoryLayout<Float>.size
        guard inputBytes.count == expectedBytes else {
            throw PipelineError.renderFailed(
                code: 9,
                message: "encodeDisplaySRGB: input \(inputBytes.count) bytes != expected \(expectedBytes)"
            )
        }
        var output = Data(count: expectedBytes)
        let rc = output.withUnsafeMutableBytes { outBuf -> Int32 in
            let outPtr = outBuf.bindMemory(to: Float.self).baseAddress!
            return inputBytes.withUnsafeBytes { inBuf -> Int32 in
                let inPtr = inBuf.bindMemory(to: Float.self).baseAddress!
                return maple_encode_display_srgb_f32(
                    inPtr, UInt32(width), UInt32(height), outPtr
                )
            }
        }
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        return output
    }

    /// #2092 — fused per-tick entry: `applySceneLinearChain` followed by
    /// `encodeDisplaySRGB` in ONE FFI call over ONE input/output buffer,
    /// via `maple_apply_chain_and_encode_display_f32`. The Rust side calls
    /// the exact same two functions the two-step Swift path calls
    /// (`maple_apply_scene_linear_chain_f32` then
    /// `maple_encode_display_srgb_f32`), back-to-back through an
    /// internal Rust-owned intermediate buffer — no Swift-side CIImage
    /// wrap/readback between the two stages. See
    /// `raw-ffi/src/scene_linear_chain_fused.rs` for the Rust entry and
    /// its byte-identity unit tests.
    ///
    /// Caller contract mirrors `applySceneLinearChain` / `encodeDisplaySRGB`
    /// exactly: `inputBytes` must be `16 * width * height` bytes
    /// (`extendedLinearITUR_2020` scene-linear f32 RGBA), output is the
    /// same size, sRGB-gamma-encoded sRGB-primary f32 RGBA. Throws with
    /// the SAME error codes the two-step calls would produce for the
    /// stage that actually failed (the fused entry propagates the
    /// underlying stage's rc unchanged) — callers that fall back to the
    /// two-step path on failure see no new failure modes.
    ///
    /// ONLY valid to call when nothing runs between the chain and the
    /// encode for this tick — see `ImageEditPipeline`'s call site for the
    /// sharpen/nr_color identity gate that makes this true.
    public static func applyChainAndEncodeDisplay(
        inputBytes: Data,
        width: Int,
        height: Int,
        params: MapleAdjustmentParams,
        noiseProfile: [Float]? = nil
    ) throws -> Data {
        // Zero/negative dims must fail HERE, not at the buffer pointers below
        // (PR #2095 review): with width or height 0, `expectedBytes` is 0, an
        // empty `inputBytes` would pass the size check, and `Data(count: 0)`
        // yields a nil `baseAddress` — the force unwraps below would trap.
        // The call site (`applyChainAndEncodeViaFusedFFI`) already guards
        // w > 0 / h > 0, but this wrapper is a public API of its own. Code 2
        // mirrors the Rust entry's own zero-dimension rc.
        guard width > 0, height > 0 else {
            throw PipelineError.renderFailed(
                code: 2,
                message: "applyChainAndEncodeDisplay: zero dimension width=\(width) height=\(height)"
            )
        }
        let lanes = width * height * 4
        let expectedBytes = lanes * MemoryLayout<Float>.size
        guard inputBytes.count == expectedBytes else {
            throw PipelineError.renderFailed(
                code: 9,
                message: "applyChainAndEncodeDisplay: input \(inputBytes.count) bytes != expected \(expectedBytes)"
            )
        }
        // Non-empty by construction: width > 0 && height > 0 (guarded above)
        // ⇒ expectedBytes > 0 ⇒ both `output` and `inputBytes` have non-nil
        // base addresses, so the `baseAddress!` unwraps below cannot trap.
        var output = Data(count: expectedBytes)
        // Same noise-profile pinning pattern as `applySceneLinearChain`.
        let rc: Int32 = try withOptionalUnsafeBufferPointer(noiseProfile) { npBuf in
            var p = params
            if let npBuf {
                p.noise_profile_ptr = npBuf.baseAddress
                p.noise_profile_len = UInt32(npBuf.count)
            }
            return try output.withUnsafeMutableBytes { outBuf -> Int32 in
                let outPtr = outBuf.bindMemory(to: Float.self).baseAddress!
                return inputBytes.withUnsafeBytes { inBuf -> Int32 in
                    let inPtr = inBuf.bindMemory(to: Float.self).baseAddress!
                    return maple_apply_chain_and_encode_display_f32(
                        inPtr, UInt32(width), UInt32(height),
                        &p,
                        outPtr
                    )
                }
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
    /// The asset exposes neither a `primaryURL` nor a `bytesProvider`, so
    /// there is nothing to decode. Thrown by the local-histogram path for a
    /// degenerate `AssetRef`; callers fall back to the placeholder.
    case noByteSource
    /// The render was cancelled by the host (#951) — a newer decode superseded
    /// this one (asset switch / profile toggle / invalidate). Not a failure;
    /// callers map it onto the silent "dropped" path (the same place the
    /// generation guard drops stale results), not the error path.
    case cancelled

    public var errorDescription: String? {
        switch self {
        case .renderFailed(let code, let message):
            return "Pipeline render failed (code \(code)): \(message)"
        case .pathEncodingError(let url):
            return "Path cannot be encoded as UTF-8: \(url.path)"
        case .hintEncodingError(let s):
            return "Decoder hint cannot be encoded as UTF-8: \(s)"
        case .noByteSource:
            return "Asset has no file URL or bytes provider."
        case .cancelled:
            return "Render cancelled."
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
