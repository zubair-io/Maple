// DecodedBufferCache.swift — Per-asset disk cache for the Rust pipeline's
// decoded output (pre-adjustment). Paired with RenderedPreviewCache:
//   • RenderedPreviewCache caches POST-adjustment JPEG keyed on sidecar mtime.
//   • DecodedBufferCache caches PRE-adjustment JPEG keyed on asset file mtime.
//
// Storage: <folder>/.maple/decoded/<hash>.jpg. Cache hit lets EditSession
// skip the full Rust pipeline — the CIFilter chain in ImageEditPipeline
// runs against the cached decoded buffer instead.

import Foundation
import CoreImage
import CryptoKit
import OSLog

private let cacheLog = Logger(subsystem: "app.justmaple.aperture", category: "DecodedBufferCache")

public actor DecodedBufferCache {
    public static let shared = DecodedBufferCache()

    private let fm = FileManager.default
    private var cacheDir: URL?
    // Bump this when raw-core pipeline output changes meaning (e.g. colour
    // math changes, demosaic quality toggled, output format changes) — the
    // version is part of the cache key so stale entries are silently
    // ignored and overwritten.
    //
    // v4 (2026-05-23, #370): BaselineExposure compose chain rewritten —
    // the per-body `camera_calibration::baseline_exposure` lookup that
    // contributed to BE for several vendor bodies (Canon 5DM4 / 5DS R,
    // Fuji 50R / 50S, Hasselblad H2D-39, Nikon D850, Panasonic LX2) is
    // gone, replaced by the bundled DCP profile's `BaselineExposureOffset`
    // field (5/1447 profiles ship a non-zero value). Affected bodies now
    // get darker by 0.5–1.5 EV; per-fixture pixel output is materially
    // different. Bump the cache version so any decoded buffer from v3
    // (which embedded the table contribution) is silently invalidated.
    //
    // v3 (2026-05-01): color-convergence Phase 1.1 + 1.2 + 2 + 1.5 landed
    // a long sequence of pipeline-output changes that all alter pixel
    // values:
    //   - Phase 1.1: per-body BaselineExposure lookup populated for
    //     7 vendor bodies (commit 90582fe). (Removed in v4.)
    //   - Phase 1.2: DNG WB pre-gain bundle re-enabled in all 3 develop
    //     paths (full / sized / tile), with paired wb_already_baked=true
    //     on the DCP profile (commits 9588dd0 + d1f0958).
    //   - Phase 1.5: soft-floor at DCP exit on negative channels
    //     (commit b1ca4b5).
    //   - Phase 2: AgX pre-formation rolloff for hue-preserving highlights
    //     (commit 65ccc1d).
    //   - apply_scene_linear_chain switched from apply_delta to apply
    //     (commit 2cec8cc) — input contract is now "at D65".
    // Symptom of leaving an old version: app shows pre-#370 output
    // indefinitely (the cache hit short-circuits the Rust decode, then
    // the post-AgX chain runs against stale bytes that embed the
    // since-removed per-body BE table contribution).
    //
    // v5 (2026-07-06, #1801): paired with RenderedPreviewCache
    // viewTransformVersion=6. #1783 changed the decode contract — the
    // scene-linear buffer now bakes WB at the strip-XMP 6500/0 anchor and
    // the per-tick chains apply a SliderFrame-anchored delta on top. A v4
    // buffer decoded with the sidecar WB baked in gets that delta applied
    // OVER the baked WB (double-applied) while the refine pass develops
    // fresh from RAW — the exact live-vs-refine band reported on
    // TestFlight devices that carried pre-#1783 cache entries. #1756's
    // WB-frame change rode the same gap.
    //
    // v6 (2026-07-12, #1904): paired with RenderedPreviewCache
    // viewTransformVersion=7 and TileManager viewTransformVersion=4. The
    // #1893/#1894 WB series changed the decode product: the frame/profile
    // CCT solve moved to the Robertson mapping (shifts the FM retarget
    // point for the develop), and single-CM DNGs now resolve their
    // embedded calibration as the slider frame. A pre-#1894 buffer pairs
    // a stale develop with per-tick deltas anchored on the NEW frame
    // export — the mixed-anchor render (measured on test_0002 as a cyan
    // cast at correct slider values) persists until this key rotates.
    private let rustVersion: UInt32 = 6

    public init() {}

    public func configure(folderURL: URL) {
        let mapleDir = folderURL.appendingPathComponent(".maple")
        let decodedDir = mapleDir.appendingPathComponent("decoded")
        try? fm.createDirectory(at: decodedDir, withIntermediateDirectories: true)
        cacheDir = decodedDir
    }

    public func decoded(for assetURL: URL) -> CIImage? {
        guard let dir = cacheDir else {
            cacheLog.notice("DecodedBufferCache: no cacheDir configured for \(assetURL.lastPathComponent, privacy: .public) — Rust decode will run")
            return nil
        }
        let key = cacheKey(for: assetURL)
        let fileURL = dir.appendingPathComponent("\(key).jpg")
        guard fm.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL),
              let ci = CIImage(data: data) else {
            cacheLog.notice("DecodedBufferCache: MISS \(assetURL.lastPathComponent, privacy: .public) v\(self.rustVersion) — will run Rust decode")
            return nil
        }
        cacheLog.notice("DecodedBufferCache: HIT \(assetURL.lastPathComponent, privacy: .public) v\(self.rustVersion) (\(data.count) bytes) — SKIPPING Rust decode")
        return ci
    }

    public func storeDecoded(_ image: CIImage, for assetURL: URL) {
        guard let dir = cacheDir else { return }
        let key = cacheKey(for: assetURL)
        let fileURL = dir.appendingPathComponent("\(key).jpg")
        let ctx = CIContext()
        guard let data = ctx.jpegRepresentation(
            of: image,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.95]
        ) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    public func invalidate(assetURL: URL) {
        guard let dir = cacheDir else { return }
        let prefix = urlHash(assetURL.path)
        let files = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
        for f in files where f.hasPrefix(prefix) {
            try? fm.removeItem(at: dir.appendingPathComponent(f))
        }
    }

    private func cacheKey(for url: URL) -> String {
        let mtime = assetMtimeString(for: url)
        let components = "\(urlHash(url.path))_\(mtime)_v\(rustVersion)"
        return md5(components)
    }

    private func assetMtimeString(for url: URL) -> String {
        guard let attrs = try? fm.attributesOfItem(atPath: url.path),
              let mtime = attrs[.modificationDate] as? Date else { return "0" }
        return String(Int64(mtime.timeIntervalSince1970 * 1000))
    }

    private func urlHash(_ path: String) -> String { md5(path).prefix(16).description }

    private func md5(_ string: String) -> String {
        let digest = SHA256.hash(data: Data(string.utf8))
        return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }
}
