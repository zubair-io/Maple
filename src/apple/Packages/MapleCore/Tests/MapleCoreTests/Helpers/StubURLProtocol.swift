import Foundation

final class StubURLProtocol: URLProtocol {
  static var handler: ((URLRequest) -> (Int, Data, [String: String]))?
  static func register() { URLProtocol.registerClass(StubURLProtocol.self) }
  override class func canInit(with: URLRequest) -> Bool { true }
  override class func canonicalRequest(for r: URLRequest) -> URLRequest { r }
  override func startLoading() {
    guard let h = StubURLProtocol.handler else {
      client?.urlProtocol(self, didFailWithError: URLError(.unknown)); return
    }
    let (status, data, headers) = h(request)
    let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!
    client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

enum TestURLSession {
  static func make() -> URLSession {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubURLProtocol.self] + (cfg.protocolClasses ?? [])
    return URLSession(configuration: cfg)
  }
}
