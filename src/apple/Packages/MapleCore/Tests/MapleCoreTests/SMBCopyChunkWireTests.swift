import Darwin
import Foundation
import SMB2
import XCTest

final class SMBCopyChunkWireTests: XCTestCase {
  private func decodeFixed(
    structureSize: UInt16 = 49, outputCount: UInt32 = 12,
    inputCount: UInt32 = 0, outputOffset: UInt32 = 112, limits: Bool = true
  ) throws -> Int32 {
    let context = try XCTUnwrap(smb2_init_context())
    defer { smb2_destroy_context(context) }
    var request = smb2_ioctl_request()
    request.ctl_code = UInt32(SMB2_FSCTL_SRV_COPYCHUNK)
    let pdu = try XCTUnwrap(smb2_cmd_ioctl_async(context, &request, nil, nil))
    defer { smb2_free_pdu(context, pdu) }
    context.pointee.hdr.status = UInt32(SMB2_STATUS_INVALID_PARAMETER)
    pdu.pointee.copychunk_limits_reply = limits ? 1 : 0
    let size = structureSize == 9 ? 8 : 48
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
    buffer.initialize(repeating: 0, count: size)
    defer { buffer.deallocate() }
    let vector = try XCTUnwrap(smb2_add_iovector(context, &context.pointee.in, buffer, size, nil))
    smb2_set_uint16(vector, 0, structureSize)
    if structureSize != 9 {
      smb2_set_uint32(vector, 4, UInt32(SMB2_FSCTL_SRV_COPYCHUNK))
      smb2_set_uint32(vector, 28, inputCount)
      smb2_set_uint32(vector, 32, outputOffset)
      smb2_set_uint32(vector, 36, outputCount)
    }
    return smb2_process_payload_fixed(context, pdu)
  }

  func testValidatedLimitsUseIOCTLBody() throws {
    XCTAssertEqual(try decodeFixed(), 12)
  }

  func testMalformedLimitsFailClosed() throws {
    XCTAssertLessThan(try decodeFixed(outputCount: 11), 0)
    XCTAssertLessThan(try decodeFixed(inputCount: 1), 0)
    XCTAssertLessThan(try decodeFixed(outputOffset: 64), 0)
    XCTAssertLessThan(try decodeFixed(structureSize: 9), 0)
  }

  func testGenuineInvalidParameterErrorRetainsErrorParser() throws {
    XCTAssertEqual(try decodeFixed(structureSize: 9, limits: false), 0)
    XCTAssertLessThan(try decodeFixed(limits: false), 0)
  }
  func testCompoundBoundaryCannotConsumeBytesBeyondDeclaredSocketFrame() throws {
    for frameLength in [64, 72] {
      let context = try XCTUnwrap(smb2_init_context())
      defer { smb2_destroy_context(context) }
      var sockets: [Int32] = [-1, -1]
      XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets), 0)
      context.pointee.fd = sockets[0]
      defer { close(sockets[1]) }
      XCTAssertEqual(fcntl(sockets[0], F_SETFL, O_NONBLOCK), 0)
      var request = smb2_ioctl_request()
      request.ctl_code = UInt32(SMB2_FSCTL_SRV_COPYCHUNK)
      let pdu = try XCTUnwrap(smb2_cmd_ioctl_async(context, &request, nil, nil))
      context.pointee.waitqueue = pdu
      // The first packet declares only a header plus the common eight-byte
      // prefix. A lying compound offset must not consume the following packet.
      var bytes = [UInt8](repeating: 0, count: 116)
      bytes[3] = UInt8(frameLength)
      func little(_ value: UInt64, at offset: Int, width: Int) {
        for index in 0..<width {
          bytes[offset + index] = UInt8(truncatingIfNeeded: value >> (index * 8))
        }
      }
      bytes.replaceSubrange(4..<8, with: [0xfe, 0x53, 0x4d, 0x42])
      little(64, at: 8, width: 2)
      little(UInt64(SMB2_STATUS_INVALID_PARAMETER), at: 12, width: 4)
      little(UInt64(SMB2_IOCTL.rawValue), at: 16, width: 2)
      little(UInt64(SMB2_FLAGS_SERVER_TO_REDIR), at: 20, width: 4)
      little(4096, at: 24, width: 4)
      little(pdu.pointee.header.message_id, at: 28, width: 8)
      little(49, at: 68, width: 2)
      little(UInt64(SMB2_FSCTL_SRV_COPYCHUNK), at: 72, width: 4)
      XCTAssertEqual(
        bytes.withUnsafeBytes { write(sockets[1], $0.baseAddress!, $0.count) }, bytes.count)
      XCTAssertLessThan(smb2_service(context, Int32(POLLIN)), 0)
      XCTAssertLessThanOrEqual(
        context.pointee.in.num_done, frameLength + 4, "Decoder consumed the following packet")
    }
  }

  func testDecryptedBufferCannotCrossDeclaredPacketBoundary() throws {
    for frameLength in [64, 72] {
      let context = try XCTUnwrap(smb2_init_context())
      defer { smb2_destroy_context(context) }
      var request = smb2_ioctl_request()
      request.ctl_code = UInt32(SMB2_FSCTL_SRV_COPYCHUNK)
      let pdu = try XCTUnwrap(smb2_cmd_ioctl_async(context, &request, nil, nil))
      context.pointee.waitqueue = pdu
      context.pointee.recv_state = SMB2_RECV_HEADER
      context.pointee.spl = UInt32(frameLength)
      let bytes = try XCTUnwrap(malloc(112)?.assumingMemoryBound(to: UInt8.self))
      bytes.initialize(repeating: 0, count: 112)
      context.pointee.enc = bytes
      context.pointee.enc_len = 112
      func little(_ value: UInt64, at offset: Int, width: Int) {
        for index in 0..<width {
          bytes[offset + index] = UInt8(truncatingIfNeeded: value >> (index * 8))
        }
      }
      bytes[0] = 0xfe
      bytes[1] = 0x53
      bytes[2] = 0x4d
      bytes[3] = 0x42
      little(64, at: 4, width: 2)
      little(UInt64(SMB2_STATUS_INVALID_PARAMETER), at: 8, width: 4)
      little(UInt64(SMB2_IOCTL.rawValue), at: 12, width: 2)
      little(UInt64(SMB2_FLAGS_SERVER_TO_REDIR), at: 16, width: 4)
      little(4096, at: 20, width: 4)
      little(pdu.pointee.header.message_id, at: 24, width: 8)
      little(49, at: 64, width: 2)
      little(UInt64(SMB2_FSCTL_SRV_COPYCHUNK), at: 68, width: 4)
      let header = try XCTUnwrap(malloc(64)?.assumingMemoryBound(to: UInt8.self))
      _ = smb2_add_iovector(context, &context.pointee.in, header, 64, free)
      XCTAssertLessThan(smb2_read_from_buf(context), 0)
      XCTAssertLessThanOrEqual(context.pointee.in.num_done, frameLength)
    }
  }

}
