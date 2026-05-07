// URLProtocolStub.swift — minimal in-process API mocking for the cloud client tests.

import Foundation
@testable import MapleCore

final class URLProtocolStub: URLProtocol, @unchecked Sendable {
  /// Caller writes this before issuing requests. Returning `(Data, HTTPURLResponse)`
  /// per request lets sequenced tests vary the response over time.
  nonisolated(unsafe) static var responseProvider: ((URLRequest) -> (Data, HTTPURLResponse))?

  /// Captured request bodies — `URLProtocol` strips the body off the
  /// `URLRequest` once the system has handed it to the loader, so tests
  /// that need to inspect bodies must read from this dictionary keyed
  /// on URL string. Reset to empty in setUp.
  nonisolated(unsafe) static var capturedBodies: [String: Data] = [:]

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    if let body = readBody(from: request) {
      Self.capturedBodies[request.url?.absoluteString ?? ""] = body
    }
    guard let provider = Self.responseProvider else {
      let err = NSError(domain: "URLProtocolStub", code: -1,
                        userInfo: [NSLocalizedDescriptionKey: "responseProvider not set"])
      client?.urlProtocol(self, didFailWithError: err); return
    }
    let (data, response) = provider(request)
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}

  private func readBody(from req: URLRequest) -> Data? {
    if let body = req.httpBody { return body }
    if let stream = req.httpBodyStream {
      var data = Data()
      stream.open()
      defer { stream.close() }
      var buf = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let n = stream.read(&buf, maxLength: buf.count)
        if n <= 0 { break }
        data.append(buf, count: n)
      }
      return data.isEmpty ? nil : data
    }
    return nil
  }
}

extension URLSession {
  /// Returns a session whose only protocol is the stub, configured to
  /// return the same response for every request.
  static func stubbed(response: String,
                      contentType: String = "application/json",
                      status: Int = 200) -> URLSession {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [URLProtocolStub.self]
    URLProtocolStub.capturedBodies = [:]
    URLProtocolStub.responseProvider = { req in
      let resp = HTTPURLResponse(url: req.url!, statusCode: status,
                                 httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": contentType])!
      return (Data(response.utf8), resp)
    }
    return URLSession(configuration: cfg)
  }

  /// Variant where the test supplies a closure that returns the response
  /// for each request. Use for capturing bodies, multi-step flows, etc.
  static func stubbedSequence(_ provider: @escaping (URLRequest) -> (Data, HTTPURLResponse)) -> URLSession {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [URLProtocolStub.self]
    URLProtocolStub.capturedBodies = [:]
    URLProtocolStub.responseProvider = provider
    return URLSession(configuration: cfg)
  }
}

extension AuthenticatedHTTPClient {
  /// No-token convenience used by tests.
  static func unauthenticated(server: URL, urlSession: URLSession) -> AuthenticatedHTTPClient {
    AuthenticatedHTTPClient(
      server: server,
      urlSession: urlSession,
      tokensProvider: { nil },
      onTokensRefreshed: { _ in },
      onSignOut: {})
  }
}
