// ImageMetadataReader+CameraSerial.swift — EXIF body-serial-number lookup
// (issue #2656). Split out of `ImageMetadataReader.swift` rather than added
// there directly — that file already sits at the 570-line headroom warning
// (`tools/check-budget-headroom.sh`).
//
// Feeds `ExternalRenameFingerprint`'s third (optional) component: file size
// + EXIF `DateTimeOriginal` narrow a rename candidate down enormously
// already, and the camera serial tightens it further for the (rare) case of
// two different cameras producing files with the same size and timestamp.

import Foundation
import ImageIO

extension ImageMetadataReader {

    /// Best-effort read of the camera body's serial number
    /// (`kCGImagePropertyExifBodySerialNumber`, EXIF tag `0xA431`) from a
    /// URL. Returns `nil` when the file can't be opened, carries no EXIF
    /// dictionary, or the camera simply never wrote this tag — common for
    /// older bodies and many mirrorless models. A `nil` result is not an
    /// error; `ExternalRenameFingerprint` treats a missing serial as "not
    /// distinguishing," never as "unmatchable."
    ///
    /// Uses the same best-subimage selection as
    /// `readRawCaptureDateStrings(from:)` — the sensor data's EXIF
    /// dictionary for multi-IFD DNGs, not the embedded JPEG preview's at
    /// IFD 0 — so the serial and the capture-date half of the fingerprint
    /// are always read from the SAME dictionary.
    public static func readCameraSerial(from url: URL) -> String? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return readCameraSerial(from: src)
    }

    /// Sourceless variant for assets surfaced through `bytesProvider`
    /// (PhotoKit, Self-Hosted) where no stable URL exists. Mirrors
    /// `readRawCaptureDateStrings(from data:)`.
    public static func readCameraSerial(from data: Data) -> String? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return readCameraSerial(from: src)
    }

    private static func readCameraSerial(from src: CGImageSource) -> String? {
        let index = bestSubimageIndex(in: src)
        guard let raw = CGImageSourceCopyPropertiesAtIndex(src, index, nil) as? [CFString: Any],
              let exif = raw[kCGImagePropertyExifDictionary] as? [CFString: Any],
              let serial = exif[kCGImagePropertyExifBodySerialNumber] as? String,
              !serial.isEmpty
        else { return nil }
        return serial
    }
}
