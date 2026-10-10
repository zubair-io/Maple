#if os(macOS)
  import CryptoKit
  import Darwin
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

    private func addBundle(to source: URL) throws -> [String: Data] {
      let documents = [
        "bundle.json": Data("{\"purpose\":\"opaque testing documents\"}".utf8),
        "provenance/LICENSE": Data("Original license\r\n  \r\n".utf8),
        "provenance/runtime/ThirdPartyNotices.txt": Data("Original runtime notices\n".utf8),
      ]
      for (path, bytes) in documents {
        let url = source.appendingPathComponent(path)
        try FileManager.default.createDirectory(
          at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes.write(to: url)
      }
      return documents
    }

    private func snapshot(in installed: URL) throws -> URL {
      try XCTUnwrap(
        FileManager.default.contentsOfDirectory(
          at: installed.appendingPathComponent("bundles"), includingPropertiesForKeys: nil
        ).first)
    }

    func testBundleDocumentsSurviveSourceRemovalAndNewStoreByteForByte() async throws {
      let (root, source, pins) = try fixture()
      let documents = try addBundle(to: source)
      let destination = root.appendingPathComponent("installed")
      let installed = try await MacRemovalModelStore(root: destination, artifacts: pins)
        .install(from: source)
      let retained = try snapshot(in: installed)
      for (path, bytes) in documents {
        XCTAssertEqual(try Data(contentsOf: retained.appendingPathComponent(path)), bytes)
      }
      try FileManager.default.removeItem(at: source)
      let restored = try await MacRemovalModelStore(root: destination, artifacts: pins)
        .installedDirectory()
      XCTAssertEqual(restored, installed)
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: destination.path).count, 1)
    }

    func testTamperedProvenanceRefusesRestoreAndExplicitImportRepairsIt() async throws {
      let (root, source, pins) = try fixture()
      let documents = try addBundle(to: source)
      let store = MacRemovalModelStore(
        root: root.appendingPathComponent("installed"), artifacts: pins)
      let installed = try await store.install(from: source)
      let retained = try snapshot(in: installed)
      let notice = retained.appendingPathComponent("provenance/LICENSE")
      var bytes = try Data(contentsOf: notice)
      bytes[0] ^= 1
      try bytes.write(to: notice)
      do {
        _ = try await store.installedDirectory()
        XCTFail("Altered documents must refuse restoration")
      } catch {}
      let repaired = try await store.install(from: source)
      XCTAssertEqual(repaired, installed)
      XCTAssertEqual(try Data(contentsOf: notice), documents["provenance/LICENSE"])
      _ = try await store.install(from: source)
      XCTAssertEqual(
        try FileManager.default.contentsOfDirectory(
          atPath: retained.deletingLastPathComponent().path
        ).count, 1)
    }

    func testIncompleteBundlePreservesValidLegacyModels() async throws {
      let (root, source, pins) = try fixture()
      let destination = root.appendingPathComponent("installed")
      let store = MacRemovalModelStore(root: destination, artifacts: pins)
      let installed = try await store.install(from: source)
      _ = try addBundle(to: source)
      let bundle = source.appendingPathComponent("bundle.json")
      try FileManager.default.removeItem(at: bundle)
      do {
        _ = try await store.install(from: source)
        XCTFail("Missing manifest must refuse import")
      } catch {}
      try Data("opaque manifest".utf8).write(to: bundle)
      try FileManager.default.removeItem(at: source.appendingPathComponent("provenance"))
      do {
        _ = try await store.install(from: source)
        XCTFail("Missing provenance must refuse import")
      } catch {}
      let restored = try await store.installedDirectory()
      XCTAssertEqual(restored, installed)
      XCTAssertFalse(
        FileManager.default.fileExists(atPath: installed.appendingPathComponent("bundles").path))
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: destination.path).count, 1)
    }

    func testProvenanceFileAndDirectoryLinksAreRefused() async throws {
      let (root, source, pins) = try fixture()
      _ = try addBundle(to: source)
      let destination = root.appendingPathComponent("installed")
      let store = MacRemovalModelStore(root: destination, artifacts: pins)
      let installed = try await store.install(from: source)
      let notice = source.appendingPathComponent("provenance/LICENSE")
      let external = root.appendingPathComponent("external-notice")
      try FileManager.default.moveItem(at: notice, to: external)
      try FileManager.default.createSymbolicLink(at: notice, withDestinationURL: external)
      do {
        _ = try await store.install(from: source)
        XCTFail("Document links must refuse import")
      } catch {}
      try FileManager.default.removeItem(at: notice)
      try FileManager.default.moveItem(at: external, to: notice)
      let original = source.appendingPathComponent("provenance")
      let moved = root.appendingPathComponent("external-provenance")
      try FileManager.default.moveItem(at: original, to: moved)
      try FileManager.default.createSymbolicLink(at: original, withDestinationURL: moved)
      do {
        _ = try await store.install(from: source)
        XCTFail("Directory links must refuse import")
      } catch {}
      let restored = try await store.installedDirectory()
      XCTAssertEqual(restored, installed)
    }

    func testMissingReceiptTreeAndIndexRefuseRestoreAndCanBeRepaired() async throws {
      let (root, source, pins) = try fixture()
      _ = try addBundle(to: source)
      let store = MacRemovalModelStore(
        root: root.appendingPathComponent("installed"), artifacts: pins)
      let installed = try await store.install(from: source)
      try FileManager.default.removeItem(at: installed.appendingPathComponent("bundles"))
      do {
        _ = try await store.installedDirectory()
        XCTFail("Lost provenance must refuse restore")
      } catch {}
      _ = try await store.install(from: source)
      try FileManager.default.removeItem(
        at: installed.appendingPathComponent("bundle-receipts.json"))
      do {
        _ = try await store.installedDirectory()
        XCTFail("Lost index must refuse restore")
      } catch {}
      _ = try await store.install(from: source)
      let restored = try await store.installedDirectory()
      XCTAssertEqual(restored, installed)
    }

    func testReceiptTamperAndUnlistedFilesRefuseRestoreAndImportRepairsSnapshot() async throws {
      let (root, source, pins) = try fixture()
      _ = try addBundle(to: source)
      let store = MacRemovalModelStore(
        root: root.appendingPathComponent("installed"), artifacts: pins)
      let installed = try await store.install(from: source)
      let retained = try snapshot(in: installed)
      try Data("[]".utf8).write(to: retained.appendingPathComponent("receipt.json"))
      do {
        _ = try await store.installedDirectory()
        XCTFail("Receipt tamper must refuse restore")
      } catch {}
      _ = try await store.install(from: source)
      let extra = retained.appendingPathComponent("provenance/unlisted")
      try Data([1]).write(to: extra)
      do {
        _ = try await store.installedDirectory()
        XCTFail("Unlisted documents must refuse restore")
      } catch {}
      _ = try await store.install(from: source)
      XCTAssertFalse(FileManager.default.fileExists(atPath: extra.path))
      let restored = try await store.installedDirectory()
      XCTAssertEqual(restored, installed)
    }

    func testLegacyImportCannotDiscardDamagedRetainedProvenance() async throws {
      let (root, source, pins) = try fixture()
      _ = try addBundle(to: source)
      let store = MacRemovalModelStore(
        root: root.appendingPathComponent("installed"), artifacts: pins)
      let installed = try await store.install(from: source)
      let retained = try snapshot(in: installed)
      try FileManager.default.removeItem(at: retained.appendingPathComponent("provenance/LICENSE"))
      try FileManager.default.removeItem(at: source.appendingPathComponent("bundle.json"))
      try FileManager.default.removeItem(at: source.appendingPathComponent("provenance"))
      do {
        _ = try await store.install(from: source)
        XCTFail("Legacy reimport cannot drop provenance")
      } catch {}
      XCTAssertTrue(
        FileManager.default.fileExists(
          atPath: installed.appendingPathComponent("bundle-receipts.json").path))
    }

    func testDocumentSizeCountAndDepthAreBoundedBeforePublication() async throws {
      let (root, source, pins) = try fixture()
      _ = try addBundle(to: source)
      let destination = root.appendingPathComponent("installed")
      let store = MacRemovalModelStore(root: destination, artifacts: pins)
      let notice = source.appendingPathComponent("provenance/LICENSE")
      try Data(repeating: 0, count: (8 << 20) + 1).write(to: notice)
      do {
        _ = try await store.install(from: source)
        XCTFail("Oversized document must refuse import")
      } catch {}
      try Data([1]).write(to: notice)
      for i in 0..<128 {
        try Data([1]).write(to: source.appendingPathComponent("provenance/extra-\(i)"))
      }
      do {
        _ = try await store.install(from: source)
        XCTFail("Too many documents must refuse import")
      } catch {}
      try FileManager.default.removeItem(at: source.appendingPathComponent("provenance"))
      let deep = source.appendingPathComponent("provenance/1/2/3/4/5/6/7/8/9")
      try FileManager.default.createDirectory(at: deep, withIntermediateDirectories: true)
      try Data([1]).write(to: deep.appendingPathComponent("notice"))
      do {
        _ = try await store.install(from: source)
        XCTFail("Excessive depth must refuse import")
      } catch {}
      let restored = try await store.installedDirectory()
      XCTAssertNil(restored)
      XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: destination.path).isEmpty)
    }

    func testFIFOModelIsRefusedWithoutWaitingForAWriter() async throws {
      let (root, source, pins) = try fixture()
      let model = source.appendingPathComponent("fill.onnx")
      try FileManager.default.removeItem(at: model)
      XCTAssertEqual(Darwin.mkfifo(model.path, 0o600), 0)
      let destination = root.appendingPathComponent("installed")
      let store = MacRemovalModelStore(root: destination, artifacts: pins)
      do {
        _ = try await store.install(from: source)
        XCTFail("A FIFO cannot be imported as a model")
      } catch { XCTAssertTrue(error.localizedDescription.contains("regular file")) }
      let restored = try await store.installedDirectory()
      XCTAssertNil(restored)
      XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: destination.path).isEmpty)
    }

    func testMalformedBundleIndexRefusesRestoreAndExplicitImportRebuildsIt() async throws {
      let (root, source, pins) = try fixture()
      _ = try addBundle(to: source)
      let store = MacRemovalModelStore(
        root: root.appendingPathComponent("installed"), artifacts: pins)
      let installed = try await store.install(from: source)
      let index = installed.appendingPathComponent("bundle-receipts.json")
      try Data("invalid index".utf8).write(to: index)
      do {
        _ = try await store.installedDirectory()
        XCTFail("Malformed index must refuse restore")
      } catch {}
      _ = try await store.install(from: source)
      let restored = try await store.installedDirectory()
      XCTAssertEqual(restored, installed)
    }
  }
#endif
