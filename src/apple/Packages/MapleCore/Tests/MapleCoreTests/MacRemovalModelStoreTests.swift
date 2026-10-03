#if os(macOS)
  import CryptoKit
  import Foundation
  import XCTest

  @testable import MapleCore

  final class MacRemovalModelStoreTests: XCTestCase {
    private let files = [
      "fill.onnx", "encoder.onnx", "decoder.onnx", "people.onnx", "runtime.dylib",
    ]

    private func fixture() throws -> (URL, URL, [MacRemovalModelStore.Artifact]) {
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      let source = root.appendingPathComponent("source")
      try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
      addTeardownBlock { try? FileManager.default.removeItem(at: root) }
      let artifacts = try files.map { name in
        let bytes = Data(("fixture:" + name).utf8)
        try bytes.write(to: source.appendingPathComponent(name))
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        return MacRemovalModelStore.Artifact(
          file: name, sha256: digest, size: name == "runtime.dylib" ? nil : UInt64(bytes.count))
      }
      return (root, source, artifacts)
    }

    func testOwnedBytesSurviveExternalFolderRemovalAndNewStore() async throws {
      let (root, source, pins) = try fixture()
      let input = source.appendingPathComponent("encoder.onnx")
      let external = root.appendingPathComponent("external.onnx")
      try FileManager.default.moveItem(at: input, to: external)
      try FileManager.default.createSymbolicLink(at: input, withDestinationURL: external)
      let destination = root.appendingPathComponent("installed")
      let installed = try await MacRemovalModelStore(root: destination, artifacts: pins)
        .install(from: source)
      try FileManager.default.removeItem(at: source)
      try FileManager.default.removeItem(at: external)
      let restored = try await MacRemovalModelStore(root: destination, artifacts: pins)
        .installedDirectory()
      XCTAssertEqual(restored, installed)
      XCTAssertEqual(
        try Data(contentsOf: installed.appendingPathComponent("encoder.onnx")),
        Data("fixture:encoder.onnx".utf8))
      let type =
        try FileManager.default.attributesOfItem(
          atPath: installed.appendingPathComponent("encoder.onnx").path)[.type]
        as? FileAttributeType
      XCTAssertEqual(type, .typeRegular)
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: destination.path).count, 1)
    }

    func testWrongSameSizeRuntimeCannotReplaceValidInstallation() async throws {
      let (root, source, pins) = try fixture()
      let store = MacRemovalModelStore(
        root: root.appendingPathComponent("installed"), artifacts: pins)
      let installed = try await store.install(from: source)
      let original = try files.map { try Data(contentsOf: installed.appendingPathComponent($0)) }
      let runtime = source.appendingPathComponent("runtime.dylib")
      var bytes = try Data(contentsOf: runtime)
      bytes[0] ^= 1
      try bytes.write(to: runtime)
      do {
        _ = try await store.install(from: source)
        XCTFail("Wrong runtime checksum must refuse import")
      } catch { XCTAssertTrue(error.localizedDescription.contains("runtime.dylib")) }
      XCTAssertEqual(
        try files.map { try Data(contentsOf: installed.appendingPathComponent($0)) }, original)
      XCTAssertEqual(
        try FileManager.default.contentsOfDirectory(
          atPath: installed.deletingLastPathComponent().path
        ).count, 1)
    }

    func testMissingOrWrongSizedModelsNeverPublishAnInstallation() async throws {
      let (root, source, pins) = try fixture()
      let destination = root.appendingPathComponent("installed")
      let store = MacRemovalModelStore(root: destination, artifacts: pins)
      let missing = source.appendingPathComponent("decoder.onnx")
      let original = try Data(contentsOf: missing)
      try FileManager.default.removeItem(at: missing)
      do {
        _ = try await store.install(from: source)
        XCTFail("Missing model must refuse import")
      } catch {}
      try original.write(to: missing)
      try Data([0]).write(to: source.appendingPathComponent("people.onnx"))
      do {
        _ = try await store.install(from: source)
        XCTFail("Wrong model size must refuse import")
      } catch { XCTAssertTrue(error.localizedDescription.contains("people.onnx")) }
      let installed = try await store.installedDirectory()
      XCTAssertNil(installed)
      XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: destination.path).isEmpty)
    }

    func testTamperedInstallationIsRefusedAndExplicitImportRepairsIt() async throws {
      let (root, source, pins) = try fixture()
      let store = MacRemovalModelStore(
        root: root.appendingPathComponent("installed"), artifacts: pins)
      let installed = try await store.install(from: source)
      let model = installed.appendingPathComponent("fill.onnx")
      var bytes = try Data(contentsOf: model)
      bytes[0] ^= 1
      try bytes.write(to: model)
      do {
        _ = try await store.installedDirectory()
        XCTFail("Tampered model must not restore as ready")
      } catch { XCTAssertTrue(error.localizedDescription.contains("fill.onnx")) }
      let repaired = try await store.install(from: source)
      XCTAssertEqual(repaired, installed)
      XCTAssertEqual(
        try Data(contentsOf: model),
        try Data(contentsOf: source.appendingPathComponent("fill.onnx")))
      _ = try await store.install(from: source)
      XCTAssertEqual(
        try FileManager.default.contentsOfDirectory(
          atPath: installed.deletingLastPathComponent().path
        ).count, 1)
    }

    func testCancelledImportDoesNotPublishOrCreateFiles() async throws {
      let (root, source, pins) = try fixture()
      let destination = root.appendingPathComponent("installed")
      let store = MacRemovalModelStore(root: destination, artifacts: pins)
      let task = Task {
        withUnsafeCurrentTask { $0?.cancel() }
        return try await store.install(from: source)
      }
      do {
        _ = try await task.value
        XCTFail("Cancelled import must refuse publication")
      } catch { XCTAssertTrue(error is CancellationError) }
      XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    }
  }
#endif
