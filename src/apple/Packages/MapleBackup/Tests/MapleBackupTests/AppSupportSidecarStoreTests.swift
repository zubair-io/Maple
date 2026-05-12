import XCTest
@testable import MapleBackup

final class AppSupportSidecarStoreTests: XCTestCase {

    private func makeStore() throws -> (AppSupportSidecarStore, URL) {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("sidecar-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        return (AppSupportSidecarStore(root: tmp), tmp)
    }

    func testWriteAndReadRoundTrip() throws {
        let (store, tmp) = try makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let xml = #"<x:xmpmeta><rdf:RDF /></x:xmpmeta>"#
        try store.write(phassetLocalId: "ABC/L0/001", xmp: xml)
        let read = try store.read(phassetLocalId: "ABC/L0/001")
        XCTAssertEqual(read, xml)
    }

    func testSlashInIdentifierEscapedToUnderscore() throws {
        let (store, tmp) = try makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        try store.write(phassetLocalId: "ABC/L0/001", xmp: "x")
        let files = try FileManager.default.contentsOfDirectory(atPath: tmp.path)
        XCTAssertTrue(files.contains("ABC_L0_001.xmp"))
    }

    func testReadReturnsNilWhenAbsent() throws {
        let (store, tmp) = try makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        XCTAssertNil(try store.read(phassetLocalId: "DOES/NOT/EXIST"))
    }

    func testDelete() throws {
        let (store, tmp) = try makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        try store.write(phassetLocalId: "P1", xmp: "x")
        XCTAssertNotNil(try store.read(phassetLocalId: "P1"))
        try store.delete(phassetLocalId: "P1")
        XCTAssertNil(try store.read(phassetLocalId: "P1"))
    }

    func testDeleteIsIdempotent() throws {
        let (store, tmp) = try makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        // Delete on a non-existent key should not throw.
        XCTAssertNoThrow(try store.delete(phassetLocalId: "NEVER_EXISTED"))
    }

    func testOverwriteIsAtomic() throws {
        let (store, tmp) = try makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        try store.write(phassetLocalId: "P1", xmp: "old")
        try store.write(phassetLocalId: "P1", xmp: "new")
        XCTAssertEqual(try store.read(phassetLocalId: "P1"), "new")
        // No `.tmp` orphan files left over.
        let files = try FileManager.default.contentsOfDirectory(atPath: tmp.path)
        XCTAssertEqual(files.filter { $0.hasSuffix(".tmp") }.count, 0)
    }

    func testDefaultRootIsAppSupportMaplePhotoKitSidecars() throws {
        let url = try AppSupportSidecarStore.defaultRoot()
        XCTAssertTrue(url.path.contains("Maple"))
        XCTAssertTrue(url.lastPathComponent == "PhotoKitSidecars")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    }
}
