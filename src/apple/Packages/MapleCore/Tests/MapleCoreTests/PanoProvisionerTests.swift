// PanoProvisionerTests.swift — unit tests for the pano auto-provisioner (#1234 M6).
//
// Exercises the verify → install pipeline against local fixtures (no network):
//   • sha256Hex matches CryptoKit over the same bytes
//   • checksum / size mismatch are hard errors (never a silent fallback)
//   • modelFile install lands the file at modelsDir/filename
//   • (macOS) ortTarball extracts the dylib to the configured path
//   • plan() reflects on-disk state (idempotent skip of installed artifacts)
//   • canAutoProvision gating by resolution-source tier
//   • the pinned download manifest is well-formed
//
// The download step itself (URLSession) is not unit-tested here — the network
// sources + digests are verified out-of-band; these tests cover the
// correctness-critical verify/extract/install logic.
//
// Ticket: #1234 M6.

import Testing
import Foundation
import CryptoKit
@testable import MapleCore

@Suite(.serialized)
struct PanoProvisionerTests {

    // MARK: - Fixtures

    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("pano-prov-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    @discardableResult
    private func writeFixture(_ bytes: Data, to url: URL) throws -> (sha: String, size: Int) {
        try bytes.write(to: url)
        let sha = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        return (sha, bytes.count)
    }

    private func modelSpec(sha: String, size: Int, filename: String = "model.onnx") -> PanoArtifactSpec {
        PanoArtifactSpec(
            label: "Test model",
            url: URL(string: "https://example.invalid/model.onnx")!,
            sha256: sha,
            size: size,
            kind: .modelFile(filename: filename)
        )
    }

    // MARK: - sha256

    @Test("sha256Hex matches CryptoKit over the same bytes")
    func sha256Matches() async throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let f = dir.appendingPathComponent("blob.bin")
        let bytes = Data((0..<5000).map { UInt8($0 & 0xff) })
        let (expected, _) = try writeFixture(bytes, to: f)
        let prov = PanoProvisioner(modelsDir: dir, ortDylibPath: nil, modelSpecs: [], ortSpec: nil)
        let actual = try await prov.sha256Hex(ofFileAt: f)
        #expect(actual == expected)
    }

    // MARK: - verify

    @Test("verify passes for a matching fixture")
    func verifyPasses() async throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let f = dir.appendingPathComponent("m.onnx")
        let (sha, size) = try writeFixture(Data("hello pano".utf8), to: f)
        let prov = PanoProvisioner(modelsDir: dir, ortDylibPath: nil, modelSpecs: [], ortSpec: nil)
        try await prov.verify(modelSpec(sha: sha, size: size), fileURL: f)
    }

    @Test("verify throws for a wrong SHA-256")
    func verifyChecksumMismatch() async throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let f = dir.appendingPathComponent("m.onnx")
        let (_, size) = try writeFixture(Data("hello pano".utf8), to: f)
        let prov = PanoProvisioner(modelsDir: dir, ortDylibPath: nil, modelSpecs: [], ortSpec: nil)
        let bad = modelSpec(sha: String(repeating: "0", count: 64), size: size)
        await #expect(throws: PanoProvisionError.self) {
            try await prov.verify(bad, fileURL: f)
        }
    }

    @Test("verify throws for a wrong byte size")
    func verifySizeMismatch() async throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let f = dir.appendingPathComponent("m.onnx")
        let (sha, size) = try writeFixture(Data("hello pano".utf8), to: f)
        let prov = PanoProvisioner(modelsDir: dir, ortDylibPath: nil, modelSpecs: [], ortSpec: nil)
        await #expect(throws: PanoProvisionError.self) {
            try await prov.verify(modelSpec(sha: sha, size: size + 1), fileURL: f)
        }
    }

    // MARK: - install (modelFile)

    @Test("install(modelFile) lands the file at modelsDir/filename")
    func installModelFile() async throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let modelsDir = dir.appendingPathComponent("models", isDirectory: true)
        let src = dir.appendingPathComponent("verified.onnx")
        let (sha, size) = try writeFixture(Data("model bytes here".utf8), to: src)
        let prov = PanoProvisioner(modelsDir: modelsDir, ortDylibPath: nil, modelSpecs: [], ortSpec: nil)
        try await prov.install(modelSpec(sha: sha, size: size, filename: "aliked.onnx"), verifiedFile: src)
        let landed = modelsDir.appendingPathComponent("aliked.onnx")
        #expect(FileManager.default.fileExists(atPath: landed.path))
    }

    // MARK: - plan idempotency

    @Test("plan lists missing models and excludes installed ones")
    func planReflectsDiskState() async throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let modelsDir = dir.appendingPathComponent("models", isDirectory: true)
        try FileManager.default.createDirectory(at: modelsDir, withIntermediateDirectories: true)
        // Real SHA, because isModelInstalled() verifies the digest (not just size).
        let (presentSha, presentSize) = try writeFixture(
            Data("the model".utf8), to: modelsDir.appendingPathComponent("present.onnx"))

        let present = PanoArtifactSpec(
            label: "Present", url: URL(string: "https://example.invalid/p")!,
            sha256: presentSha, size: presentSize,
            kind: .modelFile(filename: "present.onnx"))
        let missing = PanoArtifactSpec(
            label: "Missing", url: URL(string: "https://example.invalid/m")!,
            sha256: String(repeating: "0", count: 64), size: 123,
            kind: .modelFile(filename: "missing.onnx"))

        let prov = PanoProvisioner(modelsDir: modelsDir, ortDylibPath: nil,
                                   modelSpecs: [present, missing], ortSpec: nil)
        let plan = await prov.plan()
        #expect(plan.pending == ["Missing"])
        #expect(!plan.isComplete)
    }

    // MARK: - canAutoProvision

    @Test("canAutoProvision allows appSupport/notSet, blocks settings/env overrides")
    func canAutoProvisionGating() {
        func status(_ models: PanoProvisioningStatus.Source,
                    _ ort: PanoProvisioningStatus.Source) -> PanoProvisioningStatus {
            PanoProvisioningStatus(
                modelsDir: nil, modelsDirSource: models, modelsDirExists: false,
                ortDylibPath: nil, ortDylibSource: ort, ortDylibExists: false)
        }
        #expect(PanoProvisioner.canAutoProvision(status(.appSupport, .appSupport)))
        #expect(PanoProvisioner.canAutoProvision(status(.notSet, .notSet)))
        #expect(!PanoProvisioner.canAutoProvision(status(.settings, .appSupport)))
        #if os(macOS)
        // macOS cares about the ORT source too (it downloads the dylib).
        #expect(!PanoProvisioner.canAutoProvision(status(.appSupport, .environment)))
        #else
        // iOS ignores the ORT source (the runtime is embedded at build time).
        #expect(PanoProvisioner.canAutoProvision(status(.appSupport, .environment)))
        #endif
    }

    @Test("a right-sized but wrong-content file is not treated as installed")
    func rejectsWrongContentSameSize() async throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let modelsDir = dir.appendingPathComponent("models", isDirectory: true)
        try FileManager.default.createDirectory(at: modelsDir, withIntermediateDirectories: true)
        let real = Data(repeating: 0x41, count: 256)
        let wrong = Data(repeating: 0x42, count: 256)   // same size, different bytes
        try wrong.write(to: modelsDir.appendingPathComponent("m.onnx"))
        let realSha = SHA256.hash(data: real).map { String(format: "%02x", $0) }.joined()
        let spec = PanoArtifactSpec(
            label: "M", url: URL(string: "https://example.invalid/m")!,
            sha256: realSha, size: real.count, kind: .modelFile(filename: "m.onnx"))
        let prov = PanoProvisioner(modelsDir: modelsDir, ortDylibPath: nil, modelSpecs: [spec], ortSpec: nil)
        let plan = await prov.plan()
        #expect(plan.pending == ["M"], "a wrong-content file must not count as installed")
    }

    @Test("isReady: macOS needs models + ORT; iOS needs models only")
    func isReadyPlatform() {
        func st(_ models: Bool, _ ort: Bool) -> PanoProvisioningStatus {
            PanoProvisioningStatus(
                modelsDir: nil, modelsDirSource: .appSupport, modelsDirExists: models,
                ortDylibPath: nil, ortDylibSource: .appSupport, ortDylibExists: ort)
        }
        #if os(macOS)
        #expect(PanoProvisioner.isReady(st(true, true)))
        #expect(!PanoProvisioner.isReady(st(true, false)))
        #else
        #expect(PanoProvisioner.isReady(st(true, false)))   // iOS: ORT embedded at build time
        #expect(!PanoProvisioner.isReady(st(false, false)))
        #endif
    }

    // MARK: - manifest sanity

    @Test("pinned manifest is well-formed (https, lowercase 64-hex sha, positive size)")
    func manifestWellFormed() {
        var specs = PanoProvisionManifest.models
        if let ort = PanoProvisionManifest.ortRuntime { specs.append(ort) }
        #expect(!specs.isEmpty)
        for s in specs {
            #expect(s.url.scheme == "https", "\(s.label) must use https")
            #expect(s.size > 0, "\(s.label) size must be positive")
            #expect(s.sha256.count == 64, "\(s.label) sha must be 64 chars")
            #expect(s.sha256.allSatisfy { $0.isHexDigit && !$0.isUppercase },
                    "\(s.label) sha must be lowercase hex")
        }
        #expect(PanoProvisioner.approximateDownloadBytes > 0)
    }

    // MARK: - macOS ORT tarball extraction

    #if os(macOS)
    @Test("install(ortTarball) extracts the dylib to the configured path")
    func installOrtTarball() async throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        // Build a fixture tarball whose root is `root/lib/libonnxruntime.dylib`.
        let stage = dir.appendingPathComponent("root/lib", isDirectory: true)
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
        try Data("fake mach-o dylib bytes".utf8)
            .write(to: stage.appendingPathComponent("libonnxruntime.dylib"))

        let tgz = dir.appendingPathComponent("ort.tgz")
        let tar = Process()
        tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        tar.arguments = ["-czf", tgz.path, "-C", dir.path, "root"]
        try tar.run(); tar.waitUntilExit()
        #expect(tar.terminationStatus == 0)

        let target = dir.appendingPathComponent("install/libonnxruntime.dylib")
        let size = (try FileManager.default.attributesOfItem(atPath: tgz.path)[.size] as? Int) ?? 0
        let spec = PanoArtifactSpec(
            label: "Test ORT", url: URL(string: "https://example.invalid/ort.tgz")!,
            sha256: String(repeating: "0", count: 64), size: size,
            kind: .ortTarball(internalDylibPath: "root/lib/libonnxruntime.dylib"))

        let prov = PanoProvisioner(modelsDir: nil, ortDylibPath: target, modelSpecs: [], ortSpec: nil)
        try await prov.install(spec, verifiedFile: tgz)
        #expect(FileManager.default.fileExists(atPath: target.path))
    }
    #endif

    // MARK: - End-to-end (network-gated)

    /// Real download → verify → install of the pinned manifest into a temp
    /// dir. Network + ~70 MB; off by default. Run with:
    ///   MAPLE_PANO_PROVISION_SMOKE=1 swift test --filter PanoProvisionerTests
    @Test(
        "E2E: real download + SHA verify + install of the pinned manifest",
        .enabled(if: ProcessInfo.processInfo.environment["MAPLE_PANO_PROVISION_SMOKE"] == "1")
    )
    func e2eRealDownload() async throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let modelsDir = dir.appendingPathComponent("models", isDirectory: true)
        let ortPath = dir.appendingPathComponent("ort/libonnxruntime.dylib")
        let prov = PanoProvisioner(
            modelsDir: modelsDir, ortDylibPath: ortPath,
            modelSpecs: PanoProvisionManifest.models, ortSpec: PanoProvisionManifest.ortRuntime)

        try await prov.provision { _ in }

        for m in PanoProvisionManifest.models {
            guard case let .modelFile(filename) = m.kind else { continue }
            let f = modelsDir.appendingPathComponent(filename)
            #expect(FileManager.default.fileExists(atPath: f.path), "\(m.label) should be installed")
            let size = (try? FileManager.default.attributesOfItem(atPath: f.path)[.size] as? Int) ?? nil
            #expect(size == m.size, "\(m.label) installed size should match the pin")
        }
        #if os(macOS)
        #expect(FileManager.default.fileExists(atPath: ortPath.path), "ORT dylib should be installed")
        #endif

        let plan = await prov.plan()
        #expect(plan.isComplete, "after provisioning, plan() should be complete")
    }
}
