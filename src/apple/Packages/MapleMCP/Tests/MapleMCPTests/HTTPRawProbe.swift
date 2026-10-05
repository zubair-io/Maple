import Darwin
import Foundation

/// Exercise wire-level rejection before a body is uploaded, and shutdown of
/// incomplete clients. URLSession buffers bodies and can mask those cases.
enum HTTPRawProbe {
  static func connect(port: Int) throws -> Int32 {
    let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw POSIXError(.EIO) }
    var timeout = timeval(tv_sec: 3, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = UInt16(port).bigEndian
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let result = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard result == 0 else {
      Darwin.close(fd)
      throw POSIXError(.ECONNREFUSED)
    }
    return fd
  }

  static func exchange(port: Int, request: String) throws -> String {
    let fd = try connect(port: port)
    defer { Darwin.close(fd) }
    let data = Data(request.utf8)
    let sent = data.withUnsafeBytes { Darwin.send(fd, $0.baseAddress, $0.count, 0) }
    guard sent == data.count else { throw POSIXError(.EIO) }
    var bytes = [UInt8](repeating: 0, count: 8192)
    let read = Darwin.recv(fd, &bytes, bytes.count, 0)
    guard read > 0 else { throw POSIXError(.EIO) }
    return String(decoding: bytes.prefix(read), as: UTF8.self)
  }
}
