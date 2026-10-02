import Foundation

/// Registered-root discovery for existing URLProtocol enumeration tests.
/// Files/XMP pairing are tested against the production API in the HTTP gate.
enum UnifiedFolderTestResponses {
  static func roots(for request: URLRequest) -> (Int, Data, [String: String])? {
    guard request.url?.path.hasSuffix("/api/folders") == true else { return nil }
    let body =
      #"[{"id":"f1","slug":"photos","path":"/","label":"Photos","file_count":1,"last_scan":null,"created_at":"2026-01-01T00:00:00Z"}]"#
    return (200, Data(body.utf8), ["Content-Type": "application/json"])
  }
}

extension URLSession {
  static func stubbedDirectorySequence(
    _ handler: @escaping (URLRequest) -> (Data, HTTPURLResponse)
  ) -> URLSession {
    stubbedSequence { request in
      if let roots = UnifiedFolderTestResponses.roots(for: request) {
        let response = HTTPURLResponse(
          url: request.url!, statusCode: roots.0,
          httpVersion: "HTTP/1.1", headerFields: roots.2)!
        return (roots.1, response)
      }
      return handler(request)
    }
  }
}
