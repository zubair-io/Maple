import Foundation

/// Response produced by a StubURLProtocol handler. Either a synthetic
/// HTTP response or a transport-level failure (URLError). Tests for the
/// offline-tolerant auth path need to simulate "no network at all"
/// (URLError) distinctly from "server returned 5xx" (HTTP), so the
/// handler can choose.
enum StubResponse {
  case http(status: Int, body: Data, headers: [String: String] = [:])
  case failure(URLError)
}

final class StubURLProtocol: URLProtocol {
  /// Rich handler — preferred. Returning `.failure(URLError(...))`
  /// causes the URLSession to throw that URLError, simulating a real
  /// transport failure (offline, DNS, TLS, timeout).
  static var responder: ((URLRequest) -> StubResponse)?
  /// Legacy tuple handler, kept for the existing
  /// AuthenticatedHTTPClientTests that predate the StubResponse type.
  static var handler: ((URLRequest) -> (Int, Data, [String: String]))?

  static func register() { URLProtocol.registerClass(StubURLProtocol.self) }

  /// Resets both handlers so a previous test's stub doesn't bleed into
  /// the next one. Call from setUp / tearDown.
  static func reset() { responder = nil; handler = nil }

  override class func canInit(with: URLRequest) -> Bool { true }
  override class func canonicalRequest(for r: URLRequest) -> URLRequest { r }
  override func startLoading() {
    let resolved: StubResponse
    if let r = StubURLProtocol.responder {
      resolved = r(request)
    } else if let h = StubURLProtocol.handler {
      let (status, data, headers) = h(request)
      resolved = .http(status: status, body: data, headers: headers)
    } else {
      client?.urlProtocol(self, didFailWithError: URLError(.unknown)); return
    }

    switch resolved {
    case .http(let status, let body, let headers):
      let resp = HTTPURLResponse(url: request.url!, statusCode: status,
                                 httpVersion: nil, headerFields: headers)!
      client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: body)
      client?.urlProtocolDidFinishLoading(self)
    case .failure(let error):
      client?.urlProtocol(self, didFailWithError: error)
    }
  }
  override func stopLoading() {}
}

enum TestURLSession {
  static func make() -> URLSession {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubURLProtocol.self] + (cfg.protocolClasses ?? [])
    // Every request through this session is answered in-process by
    // StubURLProtocol, so no legitimate call can take even a second. The
    // point of the short budget is the ILLEGITIMATE case (#2387): if a
    // request ever escapes the stub — a URL the responder doesn't cover, a
    // transport that bypasses `protocolClasses` — the default 60 s request /
    // 7 day resource timeouts turn that into a silent multi-minute pass
    // instead of a fast, obvious failure. 5 s is ~100× the slowest real
    // stubbed suite and still fails inside a normal attention span.
    cfg.timeoutIntervalForRequest = 5
    cfg.timeoutIntervalForResource = 5
    return URLSession(configuration: cfg)
  }
}
