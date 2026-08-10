// ExternalRenameFingerprint+Live.swift — the production fingerprint
// provider (issue #2656). `ExternalRenameFingerprint` itself and
// `ExternalRenameMatcher` (`ExternalRenameMatcher.swift`) stay pure and
// I/O-free so they're directly unit-testable; this is the one place that
// actually touches disk / ImageIO to build a fingerprint for a real file.
//
// Deliberately a `@Sendable (URL) -> ExternalRenameFingerprint?` value
// (not a protocol) — `ExternalRenameReconciler` takes this as an injectable
// parameter defaulting to `.live`, so tests can supply a stub that returns
// deterministic fingerprints for plain temp-dir fixtures without needing
// real EXIF-bearing RAW files on disk.

import Foundation

extension ExternalRenameFingerprint {

    /// Reads file size via `FileManager` and EXIF `DateTimeOriginal` +
    /// camera serial via `ImageMetadataReader`. Returns `nil` — never a
    /// size-only fingerprint — when the size or `DateTimeOriginal` can't be
    /// read: an unfingerprintable file is excluded from rename matching
    /// entirely rather than falling back to the one comparison
    /// (`size`-only) that would defeat the mandatory false-positive guard.
    public static let live: @Sendable (URL) -> ExternalRenameFingerprint? = { url in
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = (attrs[.size] as? NSNumber)?.int64Value
        else { return nil }
        let dates = ImageMetadataReader.readRawCaptureDateStrings(from: url)
        guard let dateTimeOriginal = dates.dateTimeOriginal, !dateTimeOriginal.isEmpty else { return nil }
        let cameraSerial = ImageMetadataReader.readCameraSerial(from: url)
        return ExternalRenameFingerprint(
            size: size, dateTimeOriginal: dateTimeOriginal, cameraSerial: cameraSerial)
    }
}
