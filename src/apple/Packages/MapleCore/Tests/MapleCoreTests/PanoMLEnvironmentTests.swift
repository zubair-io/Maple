// PanoMLEnvironmentTests.swift — the ML paths Maple exports for the core
// never read back as a user override, and "installed" means every file the
// core loads is there.

import XCTest
@testable import MapleCore

final class PanoMLEnvironmentTests: XCTestCase {
    private var tmp: URL!
    private var savedEnvironment: [String: String?] = [:]
    private let variables = [PanoProvisioningDefaults.modelsDirEnv, PanoProvisioningDefaults.ortDylibPathEnv]

    override func setUpWithError() throws {
        tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("pano-ml-env-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        savedEnvironment = Dictionary(uniqueKeysWithValues: variables.map { ($0, ProcessInfo.processInfo.environment[$0]) })
        variables.forEach { unsetenv($0) }
    }

    override func tearDownWithError() throws {
        for (name, value) in savedEnvironment {
            if let value { setenv(name, value, 1) } else { unsetenv(name) }
        }
        try? FileManager.default.removeItem(at: tmp)
    }

    private func freshDefaults() -> UserDefaults {
        let name = "pano-ml-env-\(UUID().uuidString)"
        let suite = UserDefaults(suiteName: name)!
        suite.removePersistentDomain(forName: name)
        return suite
    }

    private func modelsDir(with filenames: [String]) throws -> URL {
        let dir = tmp.appendingPathComponent("models-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for filename in filenames {
            try Data("model".utf8).write(to: dir.appendingPathComponent(filename))
        }
        return dir
    }

    private func ortDylib() throws -> URL {
        let url = tmp.appendingPathComponent("libonnxruntime-\(UUID().uuidString).dylib")
        try Data("dylib".utf8).write(to: url)
        return url
    }

    func testAPathClearedInSettingsFallsBackPastMaplesOwnExport() throws {
        let defaults = freshDefaults()
        let custom = try modelsDir(with: PanoProvisionManifest.modelFilenames)
        defaults.set(custom.path, forKey: PanoProvisioningDefaults.modelsDirKey)
        defaults.set(try ortDylib().path, forKey: PanoProvisioningDefaults.ortDylibPathKey)
        let stitcher = RustPanoStitcher(provisioning: PanoProvisioning(defaults: defaults))

        try stitcher.provisionMLEnvironment()
        XCTAssertEqual(ProcessInfo.processInfo.environment[PanoProvisioningDefaults.modelsDirEnv], custom.path)

        defaults.removeObject(forKey: PanoProvisioningDefaults.modelsDirKey)
        defaults.removeObject(forKey: PanoProvisioningDefaults.ortDylibPathKey)
        let status = PanoProvisioning(defaults: defaults).status()

        XCTAssertEqual(status.modelsDirSource, .appSupport)
        XCTAssertEqual(status.modelsDir, PanoProvisioning.defaultModelsDir())
        XCTAssertEqual(status.ortDylibSource, .appSupport)
        XCTAssertTrue(PanoProvisioner.canAutoProvision(status), "Settings must offer the download again")
    }

    func testAVariableTheUserSetStillWinsAfterAnExport() throws {
        let launched = try modelsDir(with: PanoProvisionManifest.modelFilenames)
        setenv(PanoProvisioningDefaults.modelsDirEnv, launched.path, 1)
        let defaults = freshDefaults()
        defaults.set(try modelsDir(with: PanoProvisionManifest.modelFilenames).path, forKey: PanoProvisioningDefaults.modelsDirKey)
        defaults.set(try ortDylib().path, forKey: PanoProvisioningDefaults.ortDylibPathKey)
        try RustPanoStitcher(provisioning: PanoProvisioning(defaults: defaults)).provisionMLEnvironment()

        defaults.removeObject(forKey: PanoProvisioningDefaults.modelsDirKey)
        let status = PanoProvisioning(defaults: defaults).status()

        XCTAssertEqual(status.modelsDirSource, .environment)
        XCTAssertEqual(status.modelsDir?.path, launched.path)
    }

    func testAVariableSetAfterAnExportIsTheUsersValue() throws {
        PanoMLEnvironment.export(PanoProvisioningDefaults.ortDylibPathEnv, "/maple/exported.dylib")
        XCTAssertNil(PanoMLEnvironment.userValue(PanoProvisioningDefaults.ortDylibPathEnv))

        setenv(PanoProvisioningDefaults.ortDylibPathEnv, "/user/chosen.dylib", 1)

        XCTAssertEqual(PanoMLEnvironment.userValue(PanoProvisioningDefaults.ortDylibPathEnv), "/user/chosen.dylib")
    }

    func testAModelsDirectoryMissingAModelIsNotInstalled() throws {
        let defaults = freshDefaults()
        let partial = try modelsDir(with: Array(PanoProvisionManifest.modelFilenames.prefix(1)))
        defaults.set(partial.path, forKey: PanoProvisioningDefaults.modelsDirKey)

        let status = PanoProvisioning(defaults: defaults).status()

        XCTAssertFalse(status.modelsDirExists)
        XCTAssertFalse(PanoProvisioner.isReady(status))
        XCTAssertThrowsError(try RustPanoStitcher(provisioning: PanoProvisioning(defaults: defaults)).provisionMLEnvironment()) { error in
            XCTAssertTrue(error.localizedDescription.contains("aliked-n16rot-top2k-1280.onnx"), "\(error.localizedDescription)")
            XCTAssertTrue(error.localizedDescription.contains("lightglue_for_aliked.onnx"), "\(error.localizedDescription)")
        }
    }

    func testAModelsDirectoryWithEveryModelIsInstalled() throws {
        let defaults = freshDefaults()
        defaults.set(try modelsDir(with: PanoProvisionManifest.modelFilenames).path, forKey: PanoProvisioningDefaults.modelsDirKey)

        XCTAssertTrue(PanoProvisioning(defaults: defaults).status().modelsDirExists)
    }

    func testTheModelFilenamesAreTheOnesTheCoreLoads() {
        XCTAssertEqual(PanoProvisionManifest.modelFilenames, ["aliked-n16rot-top2k-1280.onnx", "lightglue_for_aliked.onnx"])
    }
}
