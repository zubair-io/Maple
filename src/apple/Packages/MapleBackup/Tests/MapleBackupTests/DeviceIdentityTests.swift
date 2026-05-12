import XCTest
@testable import MapleBackup

final class DeviceIdentityTests: XCTestCase {
    func testCurrentIsStableAcrossCalls() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("device-id-test-\(UUID().uuidString)")
        try? FileManager.default.removeItem(at: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let id1 = try DeviceIdentity.current(storageURL: url)
        let id2 = try DeviceIdentity.current(storageURL: url)
        XCTAssertEqual(id1, id2)
        XCTAssertEqual(id1.count, 36) // RFC 4122 dashed UUID
    }
    func testCurrentDiffersAcrossDistinctStorage() throws {
        let a = FileManager.default.temporaryDirectory.appendingPathComponent("dev-a-\(UUID().uuidString)")
        let b = FileManager.default.temporaryDirectory.appendingPathComponent("dev-b-\(UUID().uuidString)")
        defer {
            try? FileManager.default.removeItem(at: a)
            try? FileManager.default.removeItem(at: b)
        }
        let id1 = try DeviceIdentity.current(storageURL: a)
        let id2 = try DeviceIdentity.current(storageURL: b)
        XCTAssertNotEqual(id1, id2)
    }
    func testTrimsWhitespaceOnRead() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("device-id-ws-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: url) }
        try "  ABC-DEF\n".write(to: url, atomically: true, encoding: .utf8)
        let id = try DeviceIdentity.current(storageURL: url)
        XCTAssertEqual(id, "ABC-DEF")
    }
    func testRegeneratesWhenFileIsBlank() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("device-id-blank-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: url) }
        try "".write(to: url, atomically: true, encoding: .utf8)
        let id = try DeviceIdentity.current(storageURL: url)
        XCTAssertEqual(id.count, 36) // a fresh UUID was generated and persisted
        let id2 = try DeviceIdentity.current(storageURL: url)
        XCTAssertEqual(id, id2) // stable on subsequent reads
    }
}
