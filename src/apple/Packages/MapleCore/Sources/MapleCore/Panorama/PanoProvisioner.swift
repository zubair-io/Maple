// PanoProvisioner.swift — auto-download + install of the pano ML runtime (#1234 M6).
//
// Replaces the manual "configure these paths yourself" flow: downloads the
// ALIKED + LightGlue ONNX models (every platform) and, on macOS, the ONNX
// Runtime dylib, verifies each against its pinned SHA-256, and installs them
// into the default Application Support locations that `PanoProvisioning`
// resolves at priority 3. After a successful run, `PanoProvisioning.status()`
// reports `isProvisioned == true` with no manual configuration.
//
// Contract:
//   • Every artifact is SHA-256 + size verified. A mismatch is a hard error
//     (the partial download is deleted); never a silent fallback.
//   • Idempotent: an artifact already present and verified on disk is skipped.
//   • iOS downloads the models only — ORT is the static framework embedded at
//     build time (scripts/fetch-ort-ios.sh).
//   • Installs ONLY to the app-support default. If a higher-priority override
//     (Settings / env var) is set, the caller should not offer auto-download
//     (see `PanoProvisioner.canAutoProvision(_:)`) — downloading wouldn't
//     change what the resolver picks.
//
// Ticket: #1234 M6.

import Foundation
import CryptoKit

// MARK: - Progress + plan

/// Overall progress for the provisioning run, suitable for a progress bar.
public struct PanoProvisionProgress: Sendable {
    /// Overall completion across all artifacts, 0...1 (weighted by byte size).
    public let fraction: Double
    /// What is happening right now ("Downloading LightGlue model…").
    public let label: String
}

/// What a provisioning run would do, given current on-disk state + platform.
public struct PanoProvisionPlan: Sendable {
    /// Labels of artifacts that still need downloading.
    public let pending: [String]
    /// True when nothing needs downloading (already fully provisioned).
    public var isComplete: Bool { pending.isEmpty }
}

// MARK: - Errors

public enum PanoProvisionError: Error, LocalizedError, Sendable {
    case checksumMismatch(artifact: String, expected: String, actual: String)
    case sizeMismatch(artifact: String, expected: Int, actual: Int)
    case downloadFailed(artifact: String, detail: String)
    case extractFailed(artifact: String, detail: String)
    case installFailed(artifact: String, detail: String)
    case unsupportedPlatform(artifact: String)

    public var errorDescription: String? {
        switch self {
        case let .checksumMismatch(a, e, ac):
            return "\(a): checksum mismatch (expected \(e.prefix(12))…, got \(ac.prefix(12))…). The download was discarded."
        case let .sizeMismatch(a, e, ac):
            return "\(a): size mismatch (expected \(e) bytes, got \(ac))."
        case let .downloadFailed(a, d):
            return "\(a): download failed — \(d)"
        case let .extractFailed(a, d):
            return "\(a): could not extract — \(d)"
        case let .installFailed(a, d):
            return "\(a): could not install — \(d)"
        case let .unsupportedPlatform(a):
            return "\(a): not downloadable on this platform."
        }
    }
}

// MARK: - PanoProvisioner

public actor PanoProvisioner {
    private let modelsDir: URL?
    private let ortDylibPath: URL?
    private let modelSpecs: [PanoArtifactSpec]
    private let ortSpec: PanoArtifactSpec?

    /// Production: installs into the app-support default locations using the
    /// pinned manifest.
    public init() {
        self.modelsDir = PanoProvisioning.defaultModelsDir()
        self.ortDylibPath = PanoProvisioning.defaultOrtDylibPath()
        self.modelSpecs = PanoProvisionManifest.models
        self.ortSpec = PanoProvisionManifest.ortRuntime
    }

    /// Testing seam: explicit destinations + specs, decoupled from the global
    /// manifest and app-support defaults (so tests never touch real paths or
    /// the network — point specs at `file://` fixtures and dirs at tmp).
    init(modelsDir: URL?, ortDylibPath: URL?, modelSpecs: [PanoArtifactSpec], ortSpec: PanoArtifactSpec?) {
        self.modelsDir = modelsDir
        self.ortDylibPath = ortDylibPath
        self.modelSpecs = modelSpecs
        self.ortSpec = ortSpec
    }

    /// Whether auto-provisioning can take effect — i.e. the resolver would
    /// actually pick up files installed into the app-support default. False
    /// when a Settings or env-var override is in force (downloading wouldn't
    /// change resolution; the user is managing paths manually).
    public nonisolated static func canAutoProvision(_ status: PanoProvisioningStatus) -> Bool {
        func tierOK(_ s: PanoProvisioningStatus.Source) -> Bool {
            s == .appSupport || s == .notSet
        }
        // ORT source only matters on macOS (iOS embeds it).
        #if os(macOS)
        return tierOK(status.modelsDirSource) && tierOK(status.ortDylibSource)
        #else
        return tierOK(status.modelsDirSource)
        #endif
    }

    /// Platform-aware readiness. macOS needs the models *and* the ORT dylib on
    /// disk; iOS needs only the models (ORT is the static framework embedded at
    /// build time, so there is no dylib file to find). Use this instead of
    /// `PanoProvisioningStatus.isProvisioned` for UI state — `isProvisioned`
    /// always requires the ORT dylib and so reads as "not ready" on iOS.
    public nonisolated static func isReady(_ status: PanoProvisioningStatus) -> Bool {
        #if os(macOS)
        return status.modelsDirExists && status.ortDylibExists
        #else
        return status.modelsDirExists
        #endif
    }

    /// Approximate total download size for a fresh provision on this
    /// platform (models everywhere, + ORT tarball on macOS). For UI copy.
    public nonisolated static var approximateDownloadBytes: Int {
        var bytes = PanoProvisionManifest.models.reduce(0) { $0 + $1.size }
        if let ort = PanoProvisionManifest.ortRuntime { bytes += ort.size }
        return bytes
    }

    /// Compute what still needs downloading without touching the network.
    public func plan() -> PanoProvisionPlan {
        var pending: [String] = []
        for spec in modelSpecs where !isModelInstalled(spec) {
            pending.append(spec.label)
        }
        if let ort = ortSpec, !isOrtInstalled() {
            pending.append(ort.label)
        }
        return PanoProvisionPlan(pending: pending)
    }

    /// Download + verify + install everything that's missing. Reports
    /// progress via `onProgress` (called off the main actor — wrap for UI).
    /// Throws `PanoProvisionError` on the first failure, leaving already
    /// installed artifacts in place.
    public func provision(
        onProgress: @escaping @Sendable (PanoProvisionProgress) -> Void
    ) async throws {
        var specs: [PanoArtifactSpec] = modelSpecs.filter { !isModelInstalled($0) }
        if let ort = ortSpec, !isOrtInstalled() {
            specs.append(ort)
        }
        guard !specs.isEmpty else {
            onProgress(PanoProvisionProgress(fraction: 1, label: "Already installed"))
            return
        }

        let totalBytes = specs.reduce(0) { $0 + $1.size }
        var completedBytes = 0

        for spec in specs {
            let base = Double(completedBytes) / Double(totalBytes)
            let weight = Double(spec.size) / Double(totalBytes)
            onProgress(PanoProvisionProgress(fraction: base, label: "Downloading \(spec.label)…"))

            let temp = try await download(spec) { fraction in
                onProgress(PanoProvisionProgress(
                    fraction: base + weight * fraction,
                    label: "Downloading \(spec.label)…"
                ))
            }
            defer { try? FileManager.default.removeItem(at: temp) }

            onProgress(PanoProvisionProgress(fraction: base + weight, label: "Verifying \(spec.label)…"))
            try verify(spec, fileURL: temp)

            onProgress(PanoProvisionProgress(fraction: base + weight, label: "Installing \(spec.label)…"))
            try install(spec, verifiedFile: temp)

            completedBytes += spec.size
        }
        onProgress(PanoProvisionProgress(fraction: 1, label: "Done"))
    }

    // MARK: - Install-state checks

    private func isModelInstalled(_ spec: PanoArtifactSpec) -> Bool {
        guard case let .modelFile(filename) = spec.kind,
              let dir = modelsDir else { return false }
        let url = dir.appendingPathComponent(filename)
        // Size gate first (cheap); only hash a same-sized file so a
        // right-sized-but-wrong-contents file isn't treated as installed
        // (honours the "present and verified" contract). The hash cost is paid
        // only when a file already exists at the target.
        guard fileSize(url) == spec.size else { return false }
        return (try? sha256Hex(ofFileAt: url)) == spec.sha256
    }

    private func isOrtInstalled() -> Bool {
        guard let url = ortDylibPath else { return false }
        // The pinned size is the tarball's, not the dylib's, so existence is
        // the gate here; a corrupt dylib surfaces as a hard FFI error at
        // stitch time. Re-running the download overwrites it.
        return FileManager.default.fileExists(atPath: url.path)
    }

    // MARK: - Download (byte-progress, ephemeral session)

    private func download(
        _ spec: PanoArtifactSpec,
        onFraction: @escaping @Sendable (Double) -> Void
    ) async throws -> URL {
        let dest = FileManager.default.temporaryDirectory
            .appendingPathComponent("pano-dl-\(UUID().uuidString)")
        let delegate = PanoDownloadDelegate(stableDestination: dest, onFraction: onFraction)
        do {
            try await delegate.run(url: spec.url)
        } catch {
            try? FileManager.default.removeItem(at: dest)
            throw PanoProvisionError.downloadFailed(artifact: spec.label, detail: error.localizedDescription)
        }
        return dest
    }

    // MARK: - Verify

    /// Internal (not private) so unit tests can exercise the verification +
    /// install pipeline directly against local fixtures, without the network.
    func verify(_ spec: PanoArtifactSpec, fileURL: URL) throws {
        let size = fileSize(fileURL) ?? -1
        guard size == spec.size else {
            throw PanoProvisionError.sizeMismatch(artifact: spec.label, expected: spec.size, actual: size)
        }
        let actual = try sha256Hex(ofFileAt: fileURL)
        guard actual == spec.sha256 else {
            throw PanoProvisionError.checksumMismatch(artifact: spec.label, expected: spec.sha256, actual: actual)
        }
    }

    // MARK: - Install

    /// Internal (not private) for the same test reason as `verify`.
    func install(_ spec: PanoArtifactSpec, verifiedFile: URL) throws {
        switch spec.kind {
        case let .modelFile(filename):
            guard let dir = modelsDir else {
                throw PanoProvisionError.installFailed(artifact: spec.label, detail: "no models dir configured")
            }
            try ensureDir(dir)
            let target = dir.appendingPathComponent(filename)
            try replaceItem(at: target, with: verifiedFile)

        case let .ortTarball(internalDylibPath):
            #if os(macOS)
            guard let dylibTarget = ortDylibPath else {
                throw PanoProvisionError.installFailed(artifact: spec.label, detail: "no ort path configured")
            }
            try installOrtTarball(spec, tarball: verifiedFile, internalDylibPath: internalDylibPath, target: dylibTarget)
            #else
            throw PanoProvisionError.unsupportedPlatform(artifact: spec.label)
            #endif
        }
    }

    #if os(macOS)
    /// Extract the dylib from the verified tarball and install it as the ORT
    /// dylib. Uses `/usr/bin/tar` (macOS only); `cp -L` dereferences the
    /// `libonnxruntime.dylib` symlink so the installed file is the real Mach-O.
    private func installOrtTarball(
        _ spec: PanoArtifactSpec,
        tarball: URL,
        internalDylibPath: String,
        target: URL
    ) throws {
        let work = FileManager.default.temporaryDirectory
            .appendingPathComponent("pano-ort-\(UUID().uuidString)", isDirectory: true)
        try ensureDir(work)
        defer { try? FileManager.default.removeItem(at: work) }

        try runTool("/usr/bin/tar", ["-xzf", tarball.path, "-C", work.path], artifact: spec.label, what: "extract")

        let extractedDylib = work.appendingPathComponent(internalDylibPath)
        guard FileManager.default.fileExists(atPath: extractedDylib.path) else {
            throw PanoProvisionError.extractFailed(
                artifact: spec.label,
                detail: "expected \(internalDylibPath) not found in archive")
        }
        // cp -L (dereference the version symlink) to a temp file, then
        // atomically replace the target — a failed copy can't leave the
        // installed dylib missing/corrupt.
        let cpTmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("pano-ort-dylib-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: cpTmp) }
        try runTool("/bin/cp", ["-L", extractedDylib.path, cpTmp.path], artifact: spec.label, what: "install")
        try replaceItem(at: target, with: cpTmp)
    }

    private func runTool(_ launchPath: String, _ args: [String], artifact: String, what: String) throws {
        func fail(_ detail: String) -> PanoProvisionError {
            what == "install"
                ? .installFailed(artifact: artifact, detail: detail)
                : .extractFailed(artifact: artifact, detail: detail)
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: launchPath)
        proc.arguments = args
        let err = Pipe()
        proc.standardError = err
        proc.standardOutput = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            throw fail("\(what): \(error.localizedDescription)")
        }
        guard proc.terminationStatus == 0 else {
            let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            throw fail("\(what) exited \(proc.terminationStatus): \(msg.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
    }
    #endif

    // MARK: - File helpers

    private func ensureDir(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    /// Atomically place `source` at `target`, replacing any existing file
    /// without a destroy-then-write window: stage into the target directory
    /// (same volume, so `moveItem` from a cross-volume temp copies into place),
    /// then atomically swap. A failure leaves any prior install intact.
    private func replaceItem(at target: URL, with source: URL) throws {
        let dir = target.deletingLastPathComponent()
        try ensureDir(dir)
        let staging = dir.appendingPathComponent(".\(target.lastPathComponent).staging-\(UUID().uuidString)")
        try? FileManager.default.removeItem(at: staging)
        try FileManager.default.moveItem(at: source, to: staging)
        if FileManager.default.fileExists(atPath: target.path) {
            _ = try FileManager.default.replaceItemAt(target, withItemAt: staging)
        } else {
            try FileManager.default.moveItem(at: staging, to: target)
        }
    }

    private func fileSize(_ url: URL) -> Int? {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? nil
    }

    func sha256Hex(ofFileAt url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
