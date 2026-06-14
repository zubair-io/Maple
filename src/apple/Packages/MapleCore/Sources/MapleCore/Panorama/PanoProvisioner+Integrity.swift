// PanoProvisioner+Integrity.swift — load-time ORT dylib integrity (#1234 M6).
//
// The app runs with `com.apple.security.cs.disable-library-validation` so it
// can `dlopen` the Microsoft-signed ONNX Runtime dylib. That dylib lives in a
// user-writable location, so a download-time SHA check alone leaves a
// tamper/replace window. These helpers re-verify the installed dylib against a
// pinned SHA-256 immediately before it is loaded; the stitch refuses to run on
// anything but `.ok`/`.notApplicable`.

import Foundation

extension PanoProvisioner {
    /// Result of re-verifying the ORT dylib just before it is loaded.
    public enum OrtDylibIntegrity: Sendable, Equatable {
        case ok
        case mismatch
        case unreadable
        /// iOS (ORT embedded at build time), or no ORT artifact in the manifest.
        case notApplicable
    }

    /// Pure, testable core: compare the file's SHA-256 to `expectedSha256`
    /// (`nil` → `.notApplicable`, missing/unreadable file → `.unreadable`).
    nonisolated static func ortIntegrity(at url: URL, expectedSha256: String?) -> OrtDylibIntegrity {
        guard let expected = expectedSha256 else { return .notApplicable }
        guard let actual = try? Self.sha256Hex(ofFileAt: url) else { return .unreadable }
        return actual == expected ? .ok : .mismatch
    }

    /// Re-verify the installed ORT dylib at `url` against the pinned SHA-256
    /// immediately before `dlopen`. iOS → `.notApplicable` (ORT is embedded).
    /// Callers must refuse to load on anything but `.ok`/`.notApplicable`.
    public nonisolated static func verifyOrtDylibIntegrity(at url: URL) -> OrtDylibIntegrity {
        #if os(macOS)
        guard let ort = PanoProvisionManifest.ortRuntime,
              case let .ortTarball(_, installedSha256) = ort.kind else { return .notApplicable }
        return ortIntegrity(at: url, expectedSha256: installedSha256)
        #else
        return .notApplicable
        #endif
    }
}
