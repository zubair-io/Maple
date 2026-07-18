// RenderedPreviewCache.swift — Per-asset JPEG preview cache.
//
// Key components (per spec § 05):
//   primaryURL hash
//   primary mtime (the RAW file's own last-modified timestamp, #1928)
//   sidecar mtime (XMP last-modified timestamp)
//   screen size (integer width class)
//   viewTransformVersion  — the local Apple bump lineage (history below)
//   pipelineOutputVersion — the single, codegen-sourced cross-platform
//                           develop-pipeline-output version (#1926)
//
// Both version fields are bumped on a pipeline-output change; going forward
// the canonical bump point is raw-core's `PIPELINE_OUTPUT_VERSION` (mirrored
// here as `AdjustmentModel.pipelineOutputVersion`), which the Web thumb cache
// keys on too — see docs/pipeline-output-version.md.
//
// Storage: .maple/previews/<key>.jpg
// Entries are invalidated on any key component change.

import Foundation
import CoreImage
import CryptoKit
import OSLog

private let cacheLog = Logger(subsystem: "app.justmaple.aperture", category: "RenderedPreviewCache")

// MARK: - RenderedPreviewCache

public actor RenderedPreviewCache {
    public static let shared = RenderedPreviewCache()

    private let fm = FileManager.default
    private var cacheDir: URL?
    private var memCache: [String: (CIImage, Date)] = [:]  // (image, stored-at)
    private let maxMemEntries = 20

    // Cache invalidation knob. Originally tied to AGX_VERSION ("bump when LUT
    // changes"), but in practice this version field IS the cache key for
    // every post-adjustment render — bump it whenever any pipeline stage
    // changes pixel output, not just the AgX LUT.
    //
    // v3 (2026-05-01): paired with DecodedBufferCache rustVersion=3. Color-
    // convergence Phase 1.1 + 1.2 + 1.5 + 2 + apply_scene_linear_chain D65
    // contract + additive BE lookup + tile-pipeline pre-gain — every one of
    // those changes pixel output. Without bumping this, the app loads the
    // pre-Phase-1.1 cached render JPEG and short-circuits the entire
    // pipeline, so users keep seeing the OLD output regardless of how many
    // times the Rust code is rebuilt.
    // v4 (#263): canonical Sobotka AgX (inset/outset matrices + real Jed
    // Smith sigmoid replacing the polynomial fit). Mid-gray now lands at
    // 0.18 instead of 0.237 — every preview from before this change reads
    // ~8% bright at mid-gray.
    // v5 (2026-05-23, #370): paired with DecodedBufferCache rustVersion=4.
    // BaselineExposure compose chain rewritten — the per-body
    // `camera_calibration::baseline_exposure` lookup that contributed to
    // BE for several vendor bodies (Canon 5DM4 / 5DS R, Fuji 50R / 50S,
    // Hasselblad H2D-39, Nikon D850, Panasonic LX2) is gone, replaced by
    // the bundled DCP profile's `BaselineExposureOffset` field. Affected
    // bodies render darker by 0.5–1.5 EV; rendered-preview JPEGs from
    // v4 still embed the old contribution and would short-circuit the
    // pipeline if not invalidated here. Bumping the decoded-buffer cache
    // alone (#370 commit) is not enough — the preview cache reads from
    // its own disk store and would otherwise keep serving pre-#370
    // output indefinitely after app update.
    // v6 (2026-07-06, #1801): paired with DecodedBufferCache rustVersion=5.
    // Catches up on three unbumped pipeline-output changes: #1756 (sidecar
    // WB re-interpreted in the camera calibration frame), #1774 (Auto 2.0
    // default profile flip — default-look output changed on every image),
    // and #1783 (decode bakes at strip-XMP 6500/0 + SliderFrame-anchored
    // per-tick WB delta). Previews cached before those changes embed the
    // old look and, uninvalidated, short-circuit the pipeline — devices
    // kept showing pre-fix output (the persistent TestFlight band/pink)
    // no matter which build was installed.
    // v7 (2026-07-12, #1904): paired with DecodedBufferCache rustVersion=6
    // and TileManager viewTransformVersion=4. The #1893/#1894 WB value-
    // mapping series changed pipeline output: kTintScale magnitude, the
    // Robertson slider mapping, the Robertson-consistent frame/profile CCT
    // solve (moves the FM retarget point), and single-CM DNGs anchoring on
    // their embedded calibration frame. Beyond the direct output shift, a
    // preview persisted by a MIXED-version build during the series' dev
    // window (new Swift + older xcframework interprets the new
    // Robertson-domain slider values in the old frame — measured on
    // test_0002 as a ~1000 K cool/cyan cast) stays key-valid at v6 and
    // short-circuits the pipeline forever; the same failure mode as v6's
    // #1801 entry.
    //
    // v8 (2026-07-12, #1976): paired with TileManager viewTransformVersion=5.
    // The per-tick WB delta anchor was a false explicit-(6500, 0) "decode
    // bake" — the strip-XMP decode omits WB and bakes at As-Shot, so every
    // settled render (GPU-live present, per-tick chain, and the previews
    // persisted FROM them via #1665/#1879) overcooled into cyan on
    // far-off-D65 bodies. Previews persisted under that anchor stay
    // key-valid at v7 and would short-circuit the pipeline forever — the
    // same failure mode as the v6/v7 entries. Apple-local bump (not
    // raw-core `PIPELINE_OUTPUT_VERSION`): raw-core's output is unchanged
    // and the web tick path has no decoded-anchor delta, so churning web
    // thumbs would invalidate correct artifacts.
    //
    // #1926: this hand-maintained per-cache integer is the drift-prone pattern
    // the codegen-sourced `AdjustmentModel.pipelineOutputVersion` supersedes.
    // Both are now folded into the key (see `variantToken`); `viewTransformVersion`
    // is retained for the documented lineage above. Raw-core OUTPUT changes
    // bump the single-sourced `PIPELINE_OUTPUT_VERSION` (invalidating this
    // cache and the Web thumb cache together); host-side render-semantics
    // fixes like v8 bump this Apple-local integer instead.
    private let viewTransformVersion: UInt32 = 8

    // MARK: - Configure

    public func configure(folderURL: URL) {
        let mapleDir = folderURL.appendingPathComponent(".maple")
        let previewDir = mapleDir.appendingPathComponent("previews")
        try? fm.createDirectory(at: previewDir, withIntermediateDirectories: true)
        cacheDir = previewDir
    }

    // MARK: - Read

    public func preview(for assetURL: URL, screenWidth: Int) -> CIImage? {
        let key = cacheKey(for: assetURL, screenWidth: screenWidth)
        // Memory
        if let (img, _) = memCache[key] {
            cacheLog.notice("RenderedPreviewCache: MEMORY HIT \(assetURL.lastPathComponent, privacy: .public) v\(self.viewTransformVersion) — SKIPPING Rust pipeline")
            return img
        }
        // Disk
        guard let dir = cacheDir else {
            cacheLog.notice("RenderedPreviewCache: no cacheDir configured")
            return nil
        }
        let fileURL = dir.appendingPathComponent("\(key).jpg")
        guard fm.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL),
              let ci = CIImage(data: data) else {
            cacheLog.notice("RenderedPreviewCache: MISS \(assetURL.lastPathComponent, privacy: .public) v\(self.viewTransformVersion) — pipeline will run")
            return nil
        }
        cacheLog.notice("RenderedPreviewCache: DISK HIT \(assetURL.lastPathComponent, privacy: .public) v\(self.viewTransformVersion) (\(data.count) bytes) — SKIPPING Rust pipeline")
        evictIfNeeded()
        memCache[key] = (ci, Date())
        return ci
    }

    // MARK: - Write

    public func storePreview(_ image: CIImage, for assetURL: URL, screenWidth: Int) {
        let key = cacheKey(for: assetURL, screenWidth: screenWidth)
        evictIfNeeded()
        memCache[key] = (image, Date())

        guard let dir = cacheDir else { return }
        let fileURL = dir.appendingPathComponent("\(key).jpg")
        let ctx = CIContext()
        guard let data = ctx.jpegRepresentation(
            of: image,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.90]
        ) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    // MARK: - Invalidate

    /// Remove all cached entries for an asset (call after sidecar write).
    /// Matches every screen-width variant by the `"{urlHash}_"` key prefix —
    /// see `cacheKey` for why the urlHash is a literal prefix.
    public func invalidate(assetURL: URL) {
        guard let dir = cacheDir else { return }
        let prefix = "\(urlHash(assetURL.path))_"
        memCache = memCache.filter { !$0.key.hasPrefix(prefix) }
        let files = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
        for f in files where f.hasPrefix(prefix) {
            try? fm.removeItem(at: dir.appendingPathComponent(f))
        }
    }

    // MARK: - Cache key

    // Key components: `(urlHash, primaryMtime, sidecarMtime, screenWidth,
    // viewTransformVersion)`. `screenWidth` is the size bucket (per ticket 06
    // § Product Requirements 5); `viewTransformVersion` invalidates on any
    // pipeline-output change.
    //
    // `primaryMtime` (#1928): the cached JPEG is rendered FROM the primary
    // RAW's pixels, so a change to those pixels that leaves the sidecar
    // untouched — re-import, external sync tool, filesystem restore — must
    // still miss. Keying only on `sidecarMtime` would serve a preview
    // developed from the old bytes under an identical key. `DecodedBufferCache`
    // (the pre-adjustment sibling) already keys on the primary mtime; this
    // brings the post-adjustment cache to parity.
    // The key is `"{urlHash}_{sha256Prefix(variant)}"` — the per-asset `urlHash` is
    // kept as a literal prefix (not folded into the outer hash) so
    // `invalidate(assetURL:)` can find every screen-width variant of an asset
    // by prefix. Hashing the whole tuple into one opaque digest, as this did
    // before, left `invalidate` unable to match any on-disk filename (it was a
    // silent no-op — masked only because a sidecar/mtime change already bumps
    // the key on the next lookup).
    private func cacheKey(for url: URL, screenWidth: Int) -> String {
        let primaryMtime = mtimeString(forPath: url.path)
        let sidecarMtime = mtimeString(forPath: SidecarPath.sidecarURL(for: url).path)
        let variant = sha256Prefix(
            Self.variantToken(
                primaryMtime: primaryMtime,
                sidecarMtime: sidecarMtime,
                screenWidth: screenWidth,
                viewTransformVersion: viewTransformVersion,
                pipelineOutputVersion: AdjustmentModel.pipelineOutputVersion))
        return "\(urlHash(url.path))_\(variant)"
    }

    /// The pre-hash variant token folded into the cache key. Kept `internal`
    /// (not `private`) and `static` so the key contract — in particular that
    /// the develop-pipeline output version participates and that bumping it
    /// changes the key — is unit-testable via `@testable`. The
    /// `pv<pipelineOutputVersion>` field is the single, codegen-sourced
    /// `AdjustmentModel.pipelineOutputVersion` (#1926): bumping it in raw-core
    /// changes this token, hence the hashed key, hence invalidates every entry.
    static func variantToken(
        primaryMtime: String,
        sidecarMtime: String,
        screenWidth: Int,
        viewTransformVersion: UInt32,
        pipelineOutputVersion: UInt32
    ) -> String {
        "\(primaryMtime)_\(sidecarMtime)_\(screenWidth)_v\(viewTransformVersion)_pv\(pipelineOutputVersion)"
    }

    /// Millisecond mtime of the file at `path`, or `"0"` when it doesn't
    /// exist / is unreadable (a missing sidecar is the common `"0"` case).
    private func mtimeString(forPath path: String) -> String {
        guard let attrs = try? fm.attributesOfItem(atPath: path),
              let mtime = attrs[.modificationDate] as? Date else { return "0" }
        return String(Int64(mtime.timeIntervalSince1970 * 1000))
    }

    private func urlHash(_ path: String) -> String { sha256Prefix(path).prefix(16).description }

    // MARK: - Eviction

    private func evictIfNeeded() {
        while memCache.count >= maxMemEntries {
            // Evict oldest
            if let oldest = memCache.min(by: { $0.value.1 < $1.value.1 }) {
                memCache.removeValue(forKey: oldest.key)
            } else { break }
        }
    }

    // MARK: - Memory pressure

    /// Drop every in-memory entry (up to `maxMemEntries` full-viewport
    /// `CIImage`s) while leaving the on-disk `.maple/previews/` files
    /// untouched — a subsequent `preview(for:)` call still hits from disk,
    /// just pays a JPEG-decode instead of a dictionary lookup. Called by
    /// `MapleApp`'s memory-pressure observer (#2037): before this, only the
    /// (already-bounded) thumbnail cache responded to pressure while this
    /// cache's larger entries sat resident.
    public func handleMemoryPressure() {
        memCache.removeAll()
    }

    // MARK: - Test hooks

    /// Whether the in-memory front is empty. `internal` (test-visible via
    /// `@testable import`) — lets a test assert `handleMemoryPressure()`
    /// actually drained `memCache` without exposing the dictionary itself.
    internal func _testMemCacheIsEmpty() -> Bool { memCache.isEmpty }

    // MARK: - Hash (SHA256 prefix for key stability)

    /// The first 16 bytes of the string's SHA256, as 32 lowercase hex chars.
    /// (`urlHash` further truncates the result to 16 hex chars.)
    private func sha256Prefix(_ string: String) -> String {
        let digest = SHA256.hash(data: Data(string.utf8))
        return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }
}
