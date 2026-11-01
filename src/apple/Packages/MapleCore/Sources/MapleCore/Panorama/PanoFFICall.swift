// PanoFFICall.swift — Synchronous calls into the raw-ffi pano entries
// (`maple_pano_stitch_aligned`, `maple_pano_preview`). Run off the MainActor
// by `RustPanoStitcher`.
//
// The solved alignment lives in memory (`PanoAlignment`); the FFI takes file
// paths, so each call stages it in a private temp directory that is removed
// as soon as the call returns. The preview PNG is decoded into memory the
// same way.
//
// Ticket: #1234 / #4579

import CoreGraphics
import Foundation
import ImageIO
import OSLog
import RawPipeline

private let panoFFILog = Logger(subsystem: "app.justmaple.aperture", category: "RustPanoStitcher")

enum PanoFFICall {
    /// Return code for "succeeded, but the offered alignment was stale or
    /// unreadable, so matching re-ran".
    private static let staleAlignmentCode: Int32 = 1

    /// Removes decoded-frame stores and per-call scratch directories left in
    /// the temp directory by a run the system terminated. Call at launch,
    /// before any stitch.
    static func sweepScratch() {
        _ = maple_pano_sweep_scratch()
        ScratchDirectory.sweep()
    }

    static func stitch(
        inputURLs: [URL],
        outputURL: URL,
        options: PanoOptions,
        engine: PanoFeatureEngine,
        alignment: PanoAlignment?,
        maxCanvasPixels: Int?,
        atom: PanoProgressAtom,
        cancelFlag: CancelFlag
    ) throws -> (outcome: PanoAlignmentOutcome, edges: PanoEdgesReport?) {
        let scratch = try ScratchDirectory()
        defer { scratch.remove() }
        let alignmentIn = try alignment.map { try scratch.write($0.json, named: "alignment-in.json") }
        let enums = CEnums(options, engine: engine)
        var edgesReport = MaplePanoEdgesReport()

        let canvasCap = UInt64(max(maxCanvasPixels ?? 0, 0))
        panoFFILog.notice("maple_pano_stitch_aligned START: \(inputURLs.count) frames, \(engine.rawValue, privacy: .public) engine → \(outputURL.lastPathComponent, privacy: .public), alignment offered: \(alignment != nil), canvas cap: \(canvasCap) px")
        let rc = try withInputs(inputURLs, atom: atom) { paths, ctx in
            try withCString(outputURL) { outPath in
                try withOptionalCString(alignmentIn) { alignmentInPath in
                    maple_pano_stitch_aligned(
                        paths.baseAddress, UInt(paths.count), outPath, alignmentInPath, canvasCap,
                        enums.edges, &edgesReport,
                        enums.retention, enums.localAlign, enums.strategy, enums.featureEngine,
                        panoProgressTrampoline, ctx, cancelFlag.pointer
                    )
                }
            }
        }
        let outcome = try outcome(rc: rc, call: "maple_pano_stitch_aligned", offered: alignment != nil)
        let edges = PanoEdgesReport(edgesReport)
        panoFFILog.notice("maple_pano_stitch_aligned OK: \(outcome.summary, privacy: .public)")
        return (outcome, edges)
    }

    static func preview(
        inputURLs: [URL],
        options: PanoOptions,
        engine: PanoFeatureEngine,
        alignment: PanoAlignment?,
        atom: PanoProgressAtom,
        cancelFlag: CancelFlag
    ) throws -> PanoPreview {
        let scratch = try ScratchDirectory()
        defer { scratch.remove() }
        let alignmentIn = try alignment.map { try scratch.write($0.json, named: "alignment-in.json") }
        let alignmentOut = scratch.url.appendingPathComponent("alignment-out.json")
        let previewPNG = scratch.url.appendingPathComponent("preview.png")
        let enums = CEnums(options, engine: engine)
        var sizes = MaplePanoPreviewSizes()
        var edgesReport = MaplePanoEdgesReport()

        panoFFILog.notice("maple_pano_preview START: \(inputURLs.count) frames, \(engine.rawValue, privacy: .public) engine, alignment offered: \(alignment != nil)")
        let rc = try withInputs(inputURLs, atom: atom) { paths, ctx in
            try withCString(previewPNG) { pngPath in
                try withOptionalCString(alignmentIn) { alignmentInPath in
                    try withCString(alignmentOut) { alignmentOutPath in
                        maple_pano_preview(
                            paths.baseAddress, UInt(paths.count), pngPath,
                            alignmentInPath, alignmentOutPath, &sizes,
                            enums.edges, &edgesReport,
                            enums.retention, enums.localAlign, enums.strategy, enums.featureEngine,
                            panoProgressTrampoline, ctx, cancelFlag.pointer
                        )
                    }
                }
            }
        }
        let outcome = try outcome(rc: rc, call: "maple_pano_preview", offered: alignment != nil)
        let image = try decodeImage(at: previewPNG)
        let solved = PanoAlignment(json: try Data(contentsOf: alignmentOut))
        let stitchSizes = PanoStitchSizes(
            canvasWidth: Int(sizes.full_width),
            canvasHeight: Int(sizes.full_height),
            largestFramePixels: Int(sizes.largest_frame_px),
            frameCount: inputURLs.count,
            scratchBytes: Int(clamping: sizes.scratch_bytes)
        )
        panoFFILog.notice("maple_pano_preview OK: \(image.width)×\(image.height), full stitch ≈ \(stitchSizes.canvasWidth)×\(stitchSizes.canvasHeight). \(outcome.summary, privacy: .public)")
        return PanoPreview(
            image: image, alignment: solved, alignmentOutcome: outcome, stitchSizes: stitchSizes,
            edges: PanoEdgesReport(edgesReport))
    }

    // MARK: - Return codes

    /// The core prefixes every error with its entry point (`maple_pano_stitch: …`),
    /// which means nothing to the user.
    static func userMessage(fromCoreError raw: String) -> String {
        raw.replacingOccurrences(of: #"^maple_[a-z_]+:\s*"#, with: "", options: .regularExpression)
    }

    /// The core words the whole outcome (`alignment not reused (<reason>);
    /// matching re-ran`); `PanoAlignmentOutcome.summary` adds its own frame,
    /// so only the reason is kept.
    static func staleReason(fromCoreMessage message: String) -> String {
        guard let match = message.firstMatch(of: #/^alignment not reused \((.+)\); matching re-ran$/#) else {
            return message
        }
        return String(match.1)
    }

    private static func outcome(rc: Int32, call: String, offered: Bool) throws -> PanoAlignmentOutcome {
        let raw = maple_last_error().map { String(cString: $0) } ?? "Something went wrong while merging."
        let message = userMessage(fromCoreError: raw)
        switch rc {
        case 0:
            return offered ? .reused : .solved
        case staleAlignmentCode:
            return .stale(reason: staleReason(fromCoreMessage: message))
        default:
            panoFFILog.error("\(call, privacy: .public) FAILED rc=\(rc): \(raw, privacy: .public)")
            switch rc {
            case -3: throw PanoStitcherError.unsupportedPlatform
            case -6: throw PanoStitcherError.modelsNotInstalled(message)
            case -9: throw PanoStitcherError.insufficientStorage
            default: throw PanoStitcherError.stitchFailed(code: Int(rc), message: message)
            }
        }
    }

    // MARK: - Image decode

    private static func decodeImage(at url: URL) throws -> CGImage {
        let data = try Data(contentsOf: url)
        let decodeNow = [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, decodeNow) else {
            throw PanoStitcherError.previewUndecodable
        }
        return image
    }

    // MARK: - Argument marshalling

    private struct CEnums {
        let retention: MaplePanoRetention
        let localAlign: MaplePanoLocalAlign
        let strategy: MaplePanoStrategy
        let featureEngine: MaplePanoFeatureEngine
        let edges: MaplePanoEdges

        init(_ options: PanoOptions, engine: PanoFeatureEngine) {
            retention = switch options.retention {
                case .keep:   Keep
                case .strict: Strict
            }
            localAlign = switch options.localAlign {
                case .mesh: Mesh
                case .off:  Off
            }
            strategy = switch options.strategy {
                case .auto:     Auto
                case .rotation: Rotation
                case .tile:     Tile
            }
            featureEngine = switch engine {
                case .classical: Classical
                case .ml:        Ml
            }
            edges = MaplePanoEdges(boundary_warp: Float(options.boundaryWarp), auto_crop: options.autoCrop)
        }
    }

    /// Pins the input path C strings, opens each input's security scope, and
    /// retains the progress atom for the duration of `body`. The FFI joins
    /// its worker threads before returning, so the trampoline never reads
    /// the atom after the release.
    private static func withInputs(
        _ inputURLs: [URL],
        atom: PanoProgressAtom,
        body: (UnsafeMutableBufferPointer<UnsafePointer<CChar>?>, UnsafeMutableRawPointer) throws -> Int32
    ) throws -> Int32 {
        let cStrings: [[CChar]] = try inputURLs.map { url in
            guard let cs = url.path.cString(using: .utf8) else {
                throw PanoStitcherError.pathEncodingError(url)
            }
            return cs
        }
        let retained = Unmanaged.passRetained(atom)
        defer { retained.release() }
        let scopes = inputURLs.map { ($0, $0.startAccessingSecurityScopedResource()) }
        defer {
            for (url, started) in scopes where started {
                url.stopAccessingSecurityScopedResource()
            }
        }
        return try withCStringPointers(cStrings, accumulated: []) { ptrs in
            var pinned = ptrs
            return try pinned.withUnsafeMutableBufferPointer { try body($0, retained.toOpaque()) }
        }
    }

    /// Nests `withUnsafeBufferPointer` closures so every base address stays
    /// valid for the whole synchronous call.
    private static func withCStringPointers<R>(
        _ strings: [[CChar]],
        accumulated: [UnsafePointer<CChar>?],
        body: ([UnsafePointer<CChar>?]) throws -> R
    ) throws -> R {
        guard let first = strings.first else { return try body(accumulated) }
        return try first.withUnsafeBufferPointer { ptr in
            try withCStringPointers(Array(strings.dropFirst()), accumulated: accumulated + [ptr.baseAddress], body: body)
        }
    }

    private static func withCString<R>(_ url: URL, body: (UnsafePointer<CChar>?) throws -> R) throws -> R {
        guard let cs = url.path.cString(using: .utf8) else {
            throw PanoStitcherError.pathEncodingError(url)
        }
        return try cs.withUnsafeBufferPointer { try body($0.baseAddress) }
    }

    private static func withOptionalCString<R>(_ url: URL?, body: (UnsafePointer<CChar>?) throws -> R) throws -> R {
        guard let url else { return try body(nil) }
        return try withCString(url, body: body)
    }
}

// MARK: - ScratchDirectory

/// A private per-call temp directory for the FFI's file-based alignment and
/// preview hand-off, named for its process like the core's frame stores so a
/// sweep can tell a terminated run's from a live one's.
struct ScratchDirectory {
    static let prefix = "maple-pano-call-"

    let url: URL

    init() throws {
        url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(Self.prefix)\(getpid())-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    func write(_ data: Data, named name: String) throws -> URL {
        let file = url.appendingPathComponent(name)
        try data.write(to: file)
        return file
    }

    func remove() {
        try? FileManager.default.removeItem(at: url)
    }

    static func sweep() {
        let temp = FileManager.default.temporaryDirectory
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: temp.path)) ?? []
        for name in entries where ownerHasExited(name) {
            try? FileManager.default.removeItem(at: temp.appendingPathComponent(name, isDirectory: true))
        }
    }

    private static func ownerHasExited(_ name: String) -> Bool {
        guard name.hasPrefix(prefix),
              let pid = name.dropFirst(prefix.count).split(separator: "-", maxSplits: 1).first.flatMap({ pid_t($0) }),
              pid > 0, pid != getpid() else { return false }
        return kill(pid, 0) != 0 && errno == ESRCH
    }
}

extension PanoEdgesReport {
    /// `nil` when the engine reported a status this build does not know, so
    /// the sheet shows the plain help rather than failing.
    init?(_ report: MaplePanoEdgesReport) {
        guard let status = PanoBoundaryWarpStatus(ffiValue: Int(report.boundary_warp_status.rawValue)) else {
            return nil
        }
        self.init(
            boundaryWarpStatus: status,
            boundaryWarpApplied: Double(report.boundary_warp_applied),
            autoCropped: report.auto_cropped)
    }
}
