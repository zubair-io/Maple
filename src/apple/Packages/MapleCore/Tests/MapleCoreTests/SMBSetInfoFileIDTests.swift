import Foundation
import SMB2
import SMB2.Internal
import SMB2.Raw
import XCTest

extension SMBDisconnectDrainTests {
  func testRenameEncodingPreservesFailedFileIDAndConvertsOnlyFilenameSeparators() throws {
    // #4093: exact persistent/volatile IDs from the cycle-94 Samba trace.
    let failed = UUID(uuid: (47, 0, 70, 233, 0, 0, 0, 0, 116, 19, 245, 58, 0, 0, 0, 0))
    // Refs #4251: exact cycle-62 CI tuple, whose volatile 0x002fd1a3 was corrupted.
    let failedCI62 = UUID(
      uuid: (0xf1, 0xa1, 0x27, 0xcd, 0, 0, 0, 0, 0xa3, 0xd1, 0x2f, 0, 0, 0, 0, 0))
    let ordinary = UUID(
      uuid: (96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111))
    var ids = [ordinary, failed, failedCI62]
    for word in 0..<8 {
      var bytes = [UInt8](repeating: 0x61, count: 16)
      bytes[word * 2] = 0x2f
      bytes[word * 2 + 1] = 0
      let id = bytes.withUnsafeBytes { $0.loadUnaligned(as: uuid_t.self) }
      ids.append(UUID(uuid: id))
    }
    for id in ids {
      for name in [
        "a/b", "owned/variant/photo.xmp", "Ω/写真.xmp",
        String(repeating: "x", count: 512) + "/sidecar.xmp",
      ] {
        let encoded = try encodeRename(id: id, name: name)
        var tuple = id.uuid
        let expectedID = withUnsafeBytes(of: &tuple) { Data($0) }
        XCTAssertEqual(
          encoded.header.subdata(in: 16..<32), expectedID, "FileID must never be filename data")
        XCTAssertEqual(Array(encoded.header.prefix(4)), [33, 0, 1, 10])
        XCTAssertEqual(Array(encoded.header[8..<16]), [96, 0, 0, 0, 0, 0, 0, 0])
        let expectedName = name.replacingOccurrences(of: "/", with: "\\").utf16.flatMap { unit in
          [UInt8(truncatingIfNeeded: unit), UInt8(truncatingIfNeeded: unit >> 8)]
        }
        XCTAssertEqual(encoded.body.subdata(in: 20..<(20 + expectedName.count)), Data(expectedName))
        XCTAssertEqual(encoded.body[0], 1)
        XCTAssertEqual(Array(encoded.body[8..<16]), [UInt8](repeating: 0, count: 8))
      }
    }
  }

  private func encodeRename(id: UUID, name: String) throws -> (header: Data, body: Data) {
    let context = try XCTUnwrap(smb2_init_context())
    defer { smb2_destroy_context(context) }
    return try name.withCString { filename in
      var rename = smb2_file_rename_info()
      rename.replace_if_exist = 1
      rename.file_name = UnsafeRawPointer(filename).assumingMemoryBound(to: UInt8.self)
      return try withUnsafeMutablePointer(to: &rename) { value in
        var request = smb2_set_info_request()
        request.file_id = id.uuid
        request.info_type = 1
        request.file_info_class = 10
        request.input_data = UnsafeMutableRawPointer(value)
        let pdu = try XCTUnwrap(smb2_cmd_set_info_async(context, &request, nil, nil))
        defer { smb2_free_pdu(context, pdu) }
        let count = Int(pdu.pointee.out.niov)
        XCTAssertGreaterThanOrEqual(count, 3)
        let vectors = withUnsafePointer(to: &pdu.pointee.out.iov) {
          $0.withMemoryRebound(to: smb2_iovec.self, capacity: count) {
            Array(UnsafeBufferPointer(start: $0, count: count))
          }
        }
        let header = Data(bytes: try XCTUnwrap(vectors[1].buf), count: Int(vectors[1].len))
        let body = Data(bytes: try XCTUnwrap(vectors[2].buf), count: Int(vectors[2].len))
        return (header, body)
      }
    }
  }
}
