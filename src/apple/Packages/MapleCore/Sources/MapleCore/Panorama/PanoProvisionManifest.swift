// PanoProvisionManifest.swift — pinned download manifest for pano auto-provisioning (#1234 M6).
//
// The two ONNX models and the macOS ONNX Runtime dylib are NOT committed to
// the repo (too large for GitHub) and are downloaded on demand by
// `PanoProvisioner`. Every artifact is pinned by SHA-256 + byte size and
// verified after download — a mismatch is a hard error, never a fallback
// (mirrors the Rust loader's contract in `maple-pano/models.toml`).
//
// Provenance (keep in sync with the Rust side):
//   • Models: src/raw-pipeline/maple-pano/models.toml — same URLs/digests.
//     The Rust loader re-verifies these digests at stitch time, so a drift
//     between this manifest and models.toml surfaces as a hard error.
//   • macOS ORT: official Microsoft GitHub release tarballs, v1.23.2
//     (load-dynamic on macOS; the error path requires ≥ 1.23). iOS does NOT
//     use this — it links the ORT static framework embedded at build time by
//     scripts/fetch-ort-ios.sh (ORT 1.22.0), so iOS provisioning fetches the
//     models only.
//
// Ticket: #1234 M6.

import Foundation

/// One downloadable, SHA-pinned artifact.
struct PanoArtifactSpec: Sendable {
    /// Human-readable label for progress UI ("ALIKED model").
    let label: String
    /// Remote source.
    let url: URL
    /// Lowercase-hex SHA-256 of the downloaded bytes.
    let sha256: String
    /// Exact byte size of the download (a cheap pre-hash sanity gate).
    let size: Int
    /// How to install the verified download.
    let kind: Kind

    enum Kind: Sendable {
        /// Plain file → install to `modelsDir/filename`.
        case modelFile(filename: String)
        /// gzip tarball → extract `internalDylibPath`, install as the ORT
        /// dylib (macOS only). `internalDylibPath` is relative to the
        /// archive root.
        case ortTarball(internalDylibPath: String)
    }
}

/// The pinned manifest. Static data — the single source of truth for what
/// `PanoProvisioner` downloads.
enum PanoProvisionManifest {
    /// ONNX models — required on every platform. URLs + digests are copied
    /// from `maple-pano/models.toml` (schema 1).
    static let models: [PanoArtifactSpec] = [
        PanoArtifactSpec(
            label: "ALIKED model",
            url: URL(string: "https://raw.githubusercontent.com/ikeboo/ALIKED-LightGlue-ONNX/77f70ddb0ee16690b674b76e7e0f5fb7c1c0e70a/onnx/aliked-n16rot-top2k-1280.onnx")!,
            sha256: "e3caf45d4ffcae936b10772ca2466365bfc863f7e119a8d19bc55529beace7d4",
            size: 13_021_915,
            kind: .modelFile(filename: "aliked-n16rot-top2k-1280.onnx")
        ),
        PanoArtifactSpec(
            label: "LightGlue model",
            url: URL(string: "https://raw.githubusercontent.com/ikeboo/ALIKED-LightGlue-ONNX/77f70ddb0ee16690b674b76e7e0f5fb7c1c0e70a/onnx/lightglue_for_aliked.onnx")!,
            sha256: "33fffedd24f39f25b139fb66f9090481d276799cef7b0ea56eb6bc0986987c38",
            size: 45_844_463,
            kind: .modelFile(filename: "lightglue_for_aliked.onnx")
        ),
    ]

    /// macOS ONNX Runtime dylib tarball for the current architecture, or
    /// `nil` on iOS (ORT is embedded as a static framework at build time).
    ///
    /// Digests pinned from the official Microsoft v1.23.2 release tarballs,
    /// verified by download (osx-arm64: b4d513ab…, osx-x86_64: d10359e1…).
    static var ortRuntime: PanoArtifactSpec? {
        #if os(macOS)
        #if arch(arm64)
        return PanoArtifactSpec(
            label: "ONNX Runtime (Apple Silicon)",
            url: URL(string: "https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-osx-arm64-1.23.2.tgz")!,
            sha256: "b4d513ab2b26f088c66891dbbc1408166708773d7cc4163de7bdca0e9bbb7856",
            size: 9_999_931,
            kind: .ortTarball(internalDylibPath: "onnxruntime-osx-arm64-1.23.2/lib/libonnxruntime.dylib")
        )
        #else
        return PanoArtifactSpec(
            label: "ONNX Runtime (Intel)",
            url: URL(string: "https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-osx-x86_64-1.23.2.tgz")!,
            sha256: "d10359e16347b57d9959f7e80a225a5b4a66ed7d7e007274a15cae86836485a6",
            size: 11_676_322,
            kind: .ortTarball(internalDylibPath: "onnxruntime-osx-x86_64-1.23.2/lib/libonnxruntime.dylib")
        )
        #endif
        #else
        // iOS/iPadOS: ORT is embedded at build time (fetch-ort-ios.sh).
        return nil
        #endif
    }
}
