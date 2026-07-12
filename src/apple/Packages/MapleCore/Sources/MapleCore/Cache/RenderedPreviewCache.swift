// RenderedPreviewCache.swift — Per-asset JPEG preview cache.
//
// Key components (per spec § 05):
//   primaryURL hash (MD5)
//   sidecar mtime (XMP last-modified timestamp)
//   screen size (integer width class)
//   viewTransformVersion (bumped on any pipeline-output change)
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
    private let viewTransformVersion: UInt32 = 7

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
    public func invalidate(assetURL: URL) {
        guard let dir = cacheDir else { return }
        // Remove all screen-width variants
        let prefix = urlHash(assetURL.path)
        memCache = memCache.filter { !$0.key.hasPrefix(prefix) }
        let files = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
        for f in files where f.hasPrefix(prefix) {
            try? fm.removeItem(at: dir.appendingPathComponent(f))
        }
    }

    // MARK: - Cache key

    // Plan 1 v2 Task 8: rendered-preview cache writes from the sized scene-
    // linear path key on size — the key tuple's existing
    // `(urlHash, sidecar mtime, screenWidth, viewTransformVersion)` is
    // sufficient because `screenWidth` is the size bucket (per ticket 06
    // § Product Requirements 5). The rest of the cache contract (mtime,
    // sidecar mtime, view transform version) is unchanged.
    private func cacheKey(for url: URL, screenWidth: Int) -> String {
        let sidecarMtime = sidecarMtimeString(for: url)
        let components = "\(urlHash(url.path))_\(sidecarMtime)_\(screenWidth)_v\(viewTransformVersion)"
        return md5(components)
    }

    private func sidecarMtimeString(for assetURL: URL) -> String {
        let sidecar = SidecarPath.sidecarURL(for: assetURL)
        guard let attrs = try? fm.attributesOfItem(atPath: sidecar.path),
              let mtime = attrs[.modificationDate] as? Date else { return "0" }
        return String(Int64(mtime.timeIntervalSince1970 * 1000))
    }

    private func urlHash(_ path: String) -> String { md5(path).prefix(16).description }

    // MARK: - Eviction

    private func evictIfNeeded() {
        while memCache.count >= maxMemEntries {
            // Evict oldest
            if let oldest = memCache.min(by: { $0.value.1 < $1.value.1 }) {
                memCache.removeValue(forKey: oldest.key)
            } else { break }
        }
    }

    // MARK: - Hash (SHA256 prefix for key stability)

    private func md5(_ string: String) -> String {
        let digest = SHA256.hash(data: Data(string.utf8))
        return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }
}
