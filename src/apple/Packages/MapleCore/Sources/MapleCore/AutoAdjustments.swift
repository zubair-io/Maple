//  AutoAdjustments.swift
//
//  Swift bridge for the one-shot AUTO slider recommendation (#1379 / M4).
//
//  Wraps the raw-ffi `maple_compute_auto_adjustments` entry: given a RAW file
//  path it decodes the RAW, develops a single AE-Off / D65 probe buffer in the
//  core, and returns recommended slider values. AUTO ships exposure + white
//  balance (temperature + tint); the five tone sliders are 0 (auto-tone is
//  deferred to #1376), so the caller applies exposure + WB only.
//
//  The fit is a cold, per-image operation (decode + probe develop, far over the
//  16ms slider budget), so it runs off the main actor via `Task.detached`.
//  Mirrors the FFI-call idiom in `AutoProfileLUT` (`withCString` + `maple_*`
//  + `maple_last_error`).

import Foundation
import RawPipeline
import os

private let autoAdjLog = Logger(subsystem: "app.justmaple.aperture", category: "auto-adjustments")

/// One-shot AUTO recommendation for a RAW. `exposure` is in EV, `temperature`
/// in Kelvin, `tint` and the five tone sliders in ±100 slider units. Tone is
/// currently 0 (deferred to #1376).
public struct AutoAdjustmentsResult: Sendable {
    public let exposure: Double
    public let temperature: Double
    public let tint: Double
    public let contrast: Double
    public let highlights: Double
    public let shadows: Double
    public let whites: Double
    public let blacks: Double
}

public enum AutoAdjustmentsError: Error, Sendable {
    /// The asset has no RAW file path (e.g. a bytes-backed asset).
    case unsupportedAsset
    /// The FFI call failed; `code` is the rc, `message` is `maple_last_error`.
    case ffiFailed(code: Int32, message: String)
}

public enum AutoAdjustments {
    /// Run the AUTO probe for the RAW at `url` off the main actor. CPU-heavy
    /// (decode + probe develop) — never call on the main thread.
    public static func compute(
        forRawAt url: URL,
        quality: PipelineRenderer.Quality = .preview
    ) async throws -> AutoAdjustmentsResult {
        let path = url.path
        return try await Task.detached(priority: .userInitiated) {
            try computeSync(rawPath: path, quality: quality)
        }.value
    }

    /// Synchronous FFI bridge. `xmp_path` is nil — AUTO is a fresh-scene
    /// recommendation, independent of the user's current sliders.
    nonisolated static func computeSync(
        rawPath: String,
        quality: PipelineRenderer.Quality
    ) throws -> AutoAdjustmentsResult {
        var out = MapleAutoAdjustments()
        let rc = rawPath.withCString { cpath in
            maple_compute_auto_adjustments(cpath, nil, quality.rawValue, &out)
        }
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown"
            autoAdjLog.error("maple_compute_auto_adjustments rc=\(rc): \(msg, privacy: .public)")
            throw AutoAdjustmentsError.ffiFailed(code: rc, message: msg)
        }
        return AutoAdjustmentsResult(
            exposure: Double(out.exposure),
            temperature: Double(out.temperature),
            tint: Double(out.tint),
            contrast: Double(out.contrast),
            highlights: Double(out.highlights),
            shadows: Double(out.shadows),
            whites: Double(out.whites),
            blacks: Double(out.blacks)
        )
    }
}
