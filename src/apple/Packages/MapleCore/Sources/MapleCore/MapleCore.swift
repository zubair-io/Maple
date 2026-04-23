// MapleCore — Swift side of the photo pipeline.
//
// Slice 10c responsibilities (per docs/spec/12-maple-apps-spec.md § 09 +
// docs/spec/00-overview.md "Apple (Swift)"):
//   - Wrap RawPipeline.xcframework (built from src/raw-pipeline/raw-ffi)
//   - EditSession (per-image transient state)
//   - ImageEditPipeline (CIFilter chain + custom Metal kernels)
//   - XMPSidecarStore (actor, reads/writes XMP sidecars)
//   - RenderedPreviewCache (disk-backed JPEG cache)
//   - Source adapters: FilesystemSource, PhotoKitSource, SMBSource

import Foundation

public enum MapleCore {
    public static let schemaVersion = "0.1.0"

    public static func version() -> String {
        "MapleCore \(schemaVersion) — stub"
    }
}
