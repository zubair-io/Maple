import Foundation
import XCTest

@testable import MapleBackup

final class BackupResourceBufferTests: XCTestCase {
  func testMappedBytesSurviveScratchRemoval() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let buffer = try BackupResourceBuffer(directory: root)
    let chunk = Data(repeating: 0xA5, count: 1024 * 1024)
    for _ in 0..<16 { try buffer.append(chunk) }
    try buffer.append(Data([1, 2, 3]))
    let data = try buffer.finish()
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    XCTAssertEqual(data.count, 16 * chunk.count + 3)
    XCTAssertEqual(data.prefix(chunk.count), chunk)
    XCTAssertEqual(data.suffix(3), Data([1, 2, 3]))
    XCTAssertThrowsError(try buffer.append(chunk))
  }

  func testCancellationRemovesPartialScratchFile() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let buffer = try BackupResourceBuffer(directory: root)
    try buffer.append(Data([1, 2, 3]))
    buffer.cancel()
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    XCTAssertThrowsError(try buffer.finish())
  }
}
