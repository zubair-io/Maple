// PresetStoreTests.swift — on-disk preset store (#1115, spec §10.7).
//
// REAL temp-dir round-trips, no mocks (the repo's sidecar-layer testing
// rule applied to presets: the JSON document on disk is the contract).

import XCTest
@testable import MapleCore

final class PresetStoreTests: XCTestCase {
    private var dir: URL!
    private var store: PresetStore!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-preset-store-tests-\(UUID().uuidString)")
        store = PresetStore(directory: dir)
    }

    override func tearDown() async throws {
        if let dir { try? FileManager.default.removeItem(at: dir) }
    }

    // MARK: - CRUD round-trip

    func testSaveListDeleteRoundTrip() async throws {
        let initial = try await store.list()
        XCTAssertEqual(initial, [])

        let beta = try await store.save(name: "Beta", fields: ["contrast": .number(5)])
        _ = try await store.save(name: "alpha", fields: ["exposure": .number(0.5)])

        // One file per preset, named <id>.json.
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted()
        XCTAssertEqual(files.count, 2)
        XCTAssertTrue(files.contains("\(beta.id).json"))

        // Name-sorted case-insensitively.
        let listed = try await store.list()
        XCTAssertEqual(listed.map(\.name), ["alpha", "Beta"])
        XCTAssertEqual(listed.first { $0.id == beta.id }?.fields, ["contrast": .number(5)])
        XCTAssertTrue(listed.allSatisfy { !$0.builtIn })
        XCTAssertTrue(listed.allSatisfy { $0.schemaVersion == presetSchemaVersion })

        try await store.delete(id: beta.id)
        let remaining = try await store.list()
        XCTAssertEqual(remaining.map(\.name), ["alpha"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("\(beta.id).json").path))
    }

    func testDeleteMissingThrowsNotFound() async throws {
        _ = try await store.save(name: "Keep", fields: ["contrast": .number(1)])
        do {
            try await store.delete(id: UUID().uuidString.lowercased())
            XCTFail("expected notFound")
        } catch let error as PresetStoreError {
            XCTAssertEqual(error, .notFound)
        }
    }

    func testDeleteRejectsUnsafeIDs() async throws {
        for id in ["../escape", "", "a/b", String(repeating: "f", count: 65)] {
            do {
                try await store.delete(id: id)
                XCTFail("expected invalidID for \(id)")
            } catch let error as PresetStoreError {
                XCTAssertEqual(error, .invalidID)
            }
        }
    }

    // MARK: - Save validation

    func testSaveRejectsDuplicateNamesCaseInsensitively() async throws {
        _ = try await store.save(name: "Golden Hour", fields: ["contrast": .number(5)])
        do {
            _ = try await store.save(name: "golden hour", fields: ["contrast": .number(9)])
            XCTFail("expected duplicateName")
        } catch let error as PresetStoreError {
            XCTAssertEqual(error, .duplicateName("golden hour"))
        }
    }

    func testSaveRejectsBuiltinNames() async throws {
        do {
            _ = try await store.save(name: "monochrome", fields: ["contrast": .number(1)])
            XCTFail("expected builtinName")
        } catch let error as PresetStoreError {
            XCTAssertEqual(error, .builtinName("monochrome"))
        }
    }

    func testSaveRejectsInvalidNamesAndEmptyFields() async throws {
        for bad in ["", "   ", "bad\nname", String(repeating: "x", count: 121)] {
            do {
                _ = try await store.save(name: bad, fields: ["contrast": .number(1)])
                XCTFail("expected invalidName for \(bad.debugDescription)")
            } catch let error as PresetStoreError {
                XCTAssertEqual(error, .invalidName)
            }
        }
        do {
            _ = try await store.save(name: "Fine Name", fields: [:])
            XCTFail("expected emptyFields")
        } catch let error as PresetStoreError {
            XCTAssertEqual(error, .emptyFields)
        }
    }

    func testSaveTrimsTheName() async throws {
        let preset = try await store.save(name: "  My Sunset  ", fields: ["contrast": .number(-25)])
        XCTAssertEqual(preset.name, "My Sunset")
        let listed = try await store.list()
        XCTAssertEqual(listed.map(\.name), ["My Sunset"])
    }

    // MARK: - Passthrough (newer-version documents)

    func testListPreservesUnknownKeysAndLeavesForeignFilesUntouched() async throws {
        // Hand-write a future-version document into the directory — as if
        // a newer Maple created it. Listing must surface it with all
        // unknown keys intact, and must NOT rewrite the file.
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let futureDoc = Data("""
        {
          "id": "0f0f0f0f-aaaa-bbbb-cccc-121212121212",
          "schemaVersion": 9,
          "name": "From The Future",
          "fields": { "contrast": 10, "future_curve_strength": 0.5 },
          "futureTopLevel": { "anything": ["goes", 1] }
        }
        """.utf8)
        let url = dir.appendingPathComponent("0f0f0f0f-aaaa-bbbb-cccc-121212121212.json")
        try futureDoc.write(to: url)

        let listed = try await store.list()
        XCTAssertEqual(listed.count, 1)
        let preset = try XCTUnwrap(listed.first)
        XCTAssertEqual(preset.schemaVersion, 9)
        XCTAssertEqual(preset.fields["future_curve_strength"], .number(0.5))
        XCTAssertEqual(
            preset.extra["futureTopLevel"],
            .object(["anything": .array([.string("goes"), .number(1)])])
        )

        // Read-only listing: the on-disk bytes are untouched.
        XCTAssertEqual(try Data(contentsOf: url), futureDoc)

        // And the preset still applies its KNOWN fields on this client.
        let (merged, applied) = PresetAdjustments.merged(.default, applying: preset.fields)
        XCTAssertEqual(applied, 1)
        XCTAssertEqual(merged.contrast, 10, accuracy: 1e-9)
    }

    func testListSkipsCorruptFiles() async throws {
        _ = try await store.save(name: "Good", fields: ["contrast": .number(1)])
        try Data("not json at all".utf8)
            .write(to: dir.appendingPathComponent("corrupt.json"))

        let listed = try await store.list()
        XCTAssertEqual(listed.map(\.name), ["Good"])
        // The corrupt file stays on disk for manual recovery.
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: dir.appendingPathComponent("corrupt.json").path)
        )
    }
}
