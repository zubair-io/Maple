// AssetRef.swift — source-agnostic asset reference.
//
// Split from EditSession.swift (issue #120) so `EditSession` only holds
// live editing state. `AssetRef` is the universal contract between
// EditSession, the rendering pipeline, and every source adapter
// (FilesystemSource, PhotoKitSource, SMBSource, CloudSource).
//
// Two shapes:
//   • File-backed — `primaryURL` set, pipeline reads from disk.
//   • Bytes-backed — `primaryURL` nil, `bytesProvider` returns RAW bytes
//     on demand for PhotoKit / Self-Hosted assets.

import Foundation

// MARK: - AssetRef

/// Lightweight reference to a source asset.
///
/// For filesystem-shaped sources (`FilesystemSource`, `SMBSource`, Files.app)
/// `primaryURL` is set and the Rust pipeline reads from disk. For sources
/// that only hand out bytes (`PhotoKitSource`, `CloudSource`)
/// `primaryURL` is `nil` and `bytesProvider` must be set to a closure that
/// fetches the full RAW bytes on demand; the pipeline then calls
/// `PipelineRenderer.render(rawBytes:hint:)`.
///
/// `AssetRef` identity is a UUID minted per session so the Browse grid can
/// diff rows — it is not a content hash.
public struct AssetRef: Identifiable, Sendable, Equatable, Hashable {
    /// On-demand bytes fetch for sourceless assets. Typed as an async
    /// `@Sendable` closure so EditSession can call it from an actor hop.
    public typealias BytesProvider = @Sendable () async throws -> Data

    public let id: UUID
    /// Filesystem URL of the RAW file. `nil` for PhotoKit / self-hosted
    /// assets that live behind an opaque identifier.
    public let primaryURL: URL?
    /// Display name. Derived from `primaryURL` when available; callers that
    /// construct URL-less refs should pass one explicitly.
    public let displayNameOverride: String?
    /// Best-effort RAW extension (without dot, e.g. "dng") for sourceless
    /// assets. Ignored when `primaryURL` is non-nil.
    public let hintExtension: String?
    /// Closure used to fetch bytes on demand. `nil` means the asset lives on
    /// disk at `primaryURL`.
    public let bytesProvider: BytesProvider?
    /// Stable cross-session identifier used as the thumbnail cache key and
    /// the deep-link resolution target (`maple://image/{id}`).
    ///
    /// For filesystem-backed assets (`AssetRef(url:)`) this is set to
    /// `url.path` so deep links can navigate to a local file by absolute path
    /// without any additional index lookup.
    ///
    /// For sourceless assets (PhotoKit, SelfHosted) this is the upstream
    /// `ImageRef.id` — a BLAKE3 maple:id hex string from the Bun API, or a
    /// PHAsset `localIdentifier`.
    public let stableID: String?

    /// Bookmark-resolved ancestor URL that grants security-scoped access to
    /// `primaryURL`. Set when the asset originated from a filesystem walk
    /// rooted at a security-scoped bookmark (user picked the folder via the
    /// system picker, or we resolved it from a persisted bookmark). Wrapping
    /// the Rust FFI read in a `startAccessingSecurityScopedResource` bracket
    /// on THIS URL — not on a path-reconstructed `deletingLastPathComponent()`
    /// — is what makes sandboxed reads actually succeed. See Port 1 notes.
    public var scopeParentURL: URL?

    public var sidecarURL: URL? {
        primaryURL.map { SidecarPath.sidecarURL(for: $0) }
    }

    /// True iff this asset has a persistent XMP sidecar next to its primary
    /// URL. Used by the S2 Library Grid "Edited" filter chip (#628).
    ///
    /// Implementation: a single `FileManager.default.fileExists` syscall
    /// per asset — cheap enough to run on every cell during filter without
    /// the lazy-load budget concerns that priming `EditSession`s would
    /// raise. For URL-less refs (PhotoKit, network) there's no sidecar
    /// to check, so the chip never includes them — accepted for v0.1.
    /// PhotoKit edit state is tracked separately by Photos itself.
    public var hasEdits: Bool {
        guard let sidecarURL else { return false }
        return FileManager.default.fileExists(atPath: sidecarURL.path)
    }

    public var displayName: String {
        if let override = displayNameOverride, !override.isEmpty {
            return override
        }
        return primaryURL?.deletingPathExtension().lastPathComponent ?? "Untitled"
    }

    /// Explicit isRaw override set by sources that know their format ahead
    /// of bytes (PhotoKit's dataUTI, Self-Hosted's API metadata). When set,
    /// `isRaw` returns this value directly; when nil, the extension-based
    /// fallback applies.
    public let explicitIsRaw: Bool?

    /// True when this asset is a standalone video container (`.mov`, `.mp4`, …).
    ///
    /// Videos are selectable in Browse so their metadata can be edited to a
    /// `clip.mov.xmp` sidecar (#1638), but they have NO still frame for the
    /// render pipeline. Callers that open an asset for preview/render must
    /// check this and no-op (or show a placeholder) — a video must never reach
    /// the RAW decoder. URL-less refs (PhotoKit/SelfHosted) are never video:
    /// those sources don't surface standalone clips through this path.
    public var isVideo: Bool {
        guard let primaryURL else { return false }
        return SidecarPath.isVideo(primaryURL)
    }

    /// True when this asset is a metadata-only "stub" image format with no
    /// realistic decode path — `eip`, `braw`, `afphoto`, `ai` (see #1835).
    /// These are indexer-eligible (filename/size/date visible in the grid)
    /// but have no thumbnail and must never reach the RAW or non-RAW
    /// decoders. URL-less refs (PhotoKit/SelfHosted) are never stub: those
    /// sources don't surface these formats through this path.
    public var isStub: Bool {
        guard let primaryURL else { return false }
        return StubExtensions.all.contains(primaryURL.pathExtension.lowercased())
    }

    /// True when this asset is a standalone audio file — `mp3`, `wav`,
    /// `m4a`, `aac` (see #1835). A wholly new asset category: same
    /// metadata-only treatment as `isStub` — no thumbnail, no decode
    /// attempt. URL-less refs are never audio.
    public var isAudio: Bool {
        guard let primaryURL else { return false }
        return AudioExtensions.all.contains(primaryURL.pathExtension.lowercased())
    }

    /// True when the asset should route through the Rust RAW decode path
    /// (rawler → DCP → demosaic → scene-linear chain). False routes through
    /// the Apple non-RAW path (`CGImageSource` → embedded ICC → scene-linear
    /// chain that skips the WB calibration / DCP / demosaic stages).
    ///
    /// Detection order:
    ///   1. `isVideo` — never RAW.
    ///   2. `isStub` / `isAudio` — metadata-only formats with no decode path
    ///      at all; never RAW.
    ///   3. `explicitIsRaw` — sources that know their format up front.
    ///   4. Extension on `primaryURL` — e.g. `dng` is RAW, `heic` is non-RAW.
    ///   5. `hintExtension` — when no URL is available.
    ///   6. Default: RAW. Maintains historical behaviour for PhotoKit/
    ///      SelfHosted refs that haven't been classified yet.
    ///
    /// `dng` is RAW even though ImageIO can also decode it — iPhone ProRAW
    /// deserves the full DCP / HSM / PTC pipeline.
    public var isRaw: Bool {
        // Videos are never RAW — short-circuit BEFORE `explicitIsRaw` and the
        // extension fallback so a clip can never route to the libraw decoder.
        // A video has no still frame; the render/open path no-ops on `isVideo`
        // (this guard is the last line of defense if a caller forgets to).
        if isVideo {
            return false
        }
        // Stub images (eip/braw/afphoto/ai) and audio (mp3/wav/m4a/aac) have
        // NO decode path at all — short-circuit before the "assume RAW"
        // fallback below would otherwise misroute them into the libraw
        // decoder. Checked before `explicitIsRaw` for the same reason video
        // is: no source should be able to force these onto the RAW path.
        if isStub || isAudio {
            return false
        }
        if let explicitIsRaw {
            return explicitIsRaw
        }
        let ext: String
        if let primaryURL {
            ext = primaryURL.pathExtension.lowercased()
        } else if let hint = hintExtension {
            ext = hint.lowercased()
        } else {
            // No URL, no hint — assume RAW so existing PhotoKit / Self-
            // Hosted RAW fixtures keep their behaviour. The non-RAW path
            // is opt-in via an explicit hint extension.
            return true
        }
        if NonRawImageExtensions.all.contains(ext) {
            return false
        }
        // Anything not in the non-RAW set (including the empty string)
        // routes through the RAW path. This covers the entire
        // RAWExtensions.all set plus formats we haven't seen yet.
        return true
    }

    /// Magic-byte sniff for the first ~16 bytes of an image. Used by
    /// PhotoKit's bytes-provider path when the source returns HEIF/JPEG
    /// without forwarding an extension hint. Returns `nil` when the
    /// signature is unrecognised — caller should fall back to extension
    /// detection (or assume RAW per the historical default).
    ///
    /// Signatures:
    ///   - JPEG: `FF D8 FF`
    ///   - PNG:  `89 50 4E 47 0D 0A 1A 0A`
    ///   - HEIF: ftyp box at offset 4 with major brand `heic`/`heix`/
    ///           `mif1`/`heim`/`heis`/`hevc`/`hevm`/`hevs`/`avif`
    public static func detectIsRaw(bytes: Data) -> Bool? {
        guard bytes.count >= 12 else { return nil }
        // JPEG magic.
        if bytes[0] == 0xFF, bytes[1] == 0xD8, bytes[2] == 0xFF {
            return false
        }
        // PNG magic.
        if bytes.count >= 8,
           bytes[0] == 0x89, bytes[1] == 0x50, bytes[2] == 0x4E, bytes[3] == 0x47,
           bytes[4] == 0x0D, bytes[5] == 0x0A, bytes[6] == 0x1A, bytes[7] == 0x0A {
            return false
        }
        // HEIF / HEIC — `ftyp` box at offset 4, brand at offset 8.
        let ftypBytes: [UInt8] = [0x66, 0x74, 0x79, 0x70]  // "ftyp"
        if bytes[4] == ftypBytes[0], bytes[5] == ftypBytes[1],
           bytes[6] == ftypBytes[2], bytes[7] == ftypBytes[3] {
            // Read 4-char brand at offset 8.
            let brand = String(bytes: bytes[8..<12], encoding: .ascii) ?? ""
            let nonRawBrands: Set<String> = [
                "heic", "heix", "mif1", "heim", "heis",
                "hevc", "hevm", "hevs", "avif",
            ]
            if nonRawBrands.contains(brand) {
                return false
            }
        }
        // Unknown signature — caller falls back.
        return nil
    }

    public init(url: URL, scopeParentURL: URL? = nil) {
        self.id = UUID()
        self.primaryURL = url
        self.displayNameOverride = nil
        self.hintExtension = url.pathExtension.isEmpty ? nil : url.pathExtension
        self.bytesProvider = nil
        self.stableID = url.path
        self.scopeParentURL = scopeParentURL
        self.explicitIsRaw = nil
    }

    /// Construct an `AssetRef` for a source without a filesystem URL
    /// (PhotoKit, self-hosted API). `bytesProvider` is invoked the first time
    /// the pipeline needs RAW bytes — callers should capture the source actor
    /// weakly, not strongly, if they want the session to deinit cleanly.
    /// `stableID` is the upstream cross-session identifier used as the
    /// thumbnail cache key (e.g. an API maple:id, a PHAsset localIdentifier).
    /// `explicitIsRaw` lets the source declare the format up front (e.g.
    /// PhotoKit's dataUTI on iCloud-resident HEIF) — without it the
    /// extension fallback or the magic-byte sniff at first byte fetch
    /// classifies the asset.
    public init(displayName: String,
                hintExtension: String?,
                stableID: String? = nil,
                explicitIsRaw: Bool? = nil,
                bytesProvider: @escaping BytesProvider) {
        self.id = UUID()
        self.primaryURL = nil
        self.displayNameOverride = displayName
        self.hintExtension = hintExtension
        self.bytesProvider = bytesProvider
        self.stableID = stableID
        self.scopeParentURL = nil
        self.explicitIsRaw = explicitIsRaw
    }

    public static func == (lhs: AssetRef, rhs: AssetRef) -> Bool {
        lhs.id == rhs.id
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    // MARK: - Preview

    /// Sample `AssetRef` for SwiftUI `#Preview` blocks. Points at a synthetic
    /// in-memory `bytesProvider` that throws when invoked — previews never
    /// actually decode pixels, so failing the fetch is acceptable; what we
    /// need is a stable `displayName` and a non-nil identity. Issue #139.
    public static func preview(displayName: String = "IMG_0042.dng",
                               hintExtension: String? = "dng") -> AssetRef {
        AssetRef(
            displayName: displayName,
            hintExtension: hintExtension,
            stableID: "preview-\(displayName)",
            explicitIsRaw: true,
            bytesProvider: {
                throw NSError(
                    domain: "MapleCore.AssetRef.preview",
                    code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "preview asset has no bytes"]
                )
            }
        )
    }
}
