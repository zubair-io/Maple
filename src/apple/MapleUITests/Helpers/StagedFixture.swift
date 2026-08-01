// StagedFixture.swift — tmp-dir fixture staging for the macOS UITest
// harnesses.
//
// Every macOS gate that needs Maple to open a specific (RAW, sidecar) pair
// stages them into a fresh tmp directory first, because the app resolves a
// sidecar by dropping the RAW's extension and re-appending `.xmp`
// (`SidecarPath.sidecarURL`). A reference XMP named after its CASE
// (`exposure_max.xmp`) or living in a committed fixture folder therefore has
// to be COPIED next to the RAW under the canonical `<stem>.xmp` name before
// the app will read it — staging in tmp also keeps the gitignored fixture
// tree read-only and gives each case an isolated `.maple/` cache root.
//
// Extracted from `SliderMatrixUITests.renderAndDiff` so the sidecar-staged
// seam gate and the poisoned-cache upgrade gate (#1805) reuse the same
// machinery instead of re-deriving the canonical-name rule.

import Foundation

#if os(macOS)

struct StagedFixture {
    /// The tmp directory. Also the folder Maple treats as the library root,
    /// so its `.maple/` subtree is this case's private cache.
    let directory: URL
    /// The staged RAW (same basename as the source).
    let raw: URL
    /// The staged sidecar, at the canonical `<stem>.xmp` path.
    let sidecar: URL

    /// Copy `raw` + `sidecar` into a fresh tmp directory, renaming the
    /// sidecar to the canonical `<stem>.xmp`. `label` only flavours the
    /// directory name so a leaked dir is traceable to its harness.
    static func stage(raw rawURL: URL,
                      sidecar sidecarURL: URL,
                      label: String) throws -> StagedFixture {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-\(label)-\(UUID().uuidString)",
                                    isDirectory: true)
        try FileManager.default.createDirectory(at: directory,
                                                withIntermediateDirectories: true)
        let stagedRaw = directory.appendingPathComponent(rawURL.lastPathComponent)
        let stagedSidecar = directory
            .appendingPathComponent(rawURL.deletingPathExtension().lastPathComponent)
            .appendingPathExtension("xmp")
        try FileManager.default.copyItem(at: rawURL, to: stagedRaw)
        try FileManager.default.copyItem(at: sidecarURL, to: stagedSidecar)
        return StagedFixture(directory: directory, raw: stagedRaw, sidecar: stagedSidecar)
    }

    /// Best-effort teardown. Callers `defer` this.
    func remove() {
        try? FileManager.default.removeItem(at: directory)
    }
}

#endif // os(macOS)
