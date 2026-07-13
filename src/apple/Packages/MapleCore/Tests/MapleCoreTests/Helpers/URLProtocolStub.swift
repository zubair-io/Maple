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

  /// Optional sleep applied between request start and response delivery.
  /// Lets tests verify behavior under bounded concurrency / generation
  /// races without waiting on real network.
  nonisolated(unsafe) static var delay: Duration = .zero

  /// Hooks fired around each loaded response. Used by concurrency-cap
  /// tests to count overlapping in-flight requests.
  nonisolated(unsafe) static var onRequestStart: (@Sendable () async -> Void)?
  nonisolated(unsafe) static var onRequestEnd: (@Sendable () async -> Void)?

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
    let delay = Self.delay
    let onStart = Self.onRequestStart
    let onEnd = Self.onRequestEnd
    let client = self.client
    let me = self
    if delay == .zero, onStart == nil, onEnd == nil {
      // Fast path — common case where no overlap counting / latency
      // simulation is needed.
      client?.urlProtocol(me, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(me, didLoad: data)
      client?.urlProtocolDidFinishLoading(me)
      return
    }
    Task.detached {
      await onStart?()
      if delay != .zero { try? await Task.sleep(for: delay) }
      client?.urlProtocol(me, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(me, didLoad: data)
      client?.urlProtocolDidFinishLoading(me)
      await onEnd?()
    }
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
  /// return the same response for every request. Optional `delay` and
  /// per-request lifecycle hooks let concurrency / generation-race
  /// tests observe in-flight overlap without real network.
  static func stubbed(response: String,
                      contentType: String = "application/json",
                      status: Int = 200,
                      delay: Duration = .zero,
                      onRequestStart: (@Sendable () async -> Void)? = nil,
                      onRequestEnd: (@Sendable () async -> Void)? = nil) -> URLSession {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [URLProtocolStub.self]
    URLProtocolStub.capturedBodies = [:]
    URLProtocolStub.delay = delay
    URLProtocolStub.onRequestStart = onRequestStart
    URLProtocolStub.onRequestEnd = onRequestEnd
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
  /// Convenience client for tests that stub the network layer and don't care
  /// about the auth layer — they exist to exercise business logic against
  /// `URLProtocolStub`, not to test token handling.
  ///
  /// Supplies a fixed, non-JWT placeholder token rather than `nil`. Since
  /// `requiredTokensForRequest()` requires a token upfront (added by
  /// `AuthenticatedHTTPClient.data(for:)`'s "unified Apple token lifecycle"
  /// change), a `nil` tokensProvider makes every call throw
  /// `.notAuthenticated` before the request ever reaches `URLProtocolStub` —
  /// which silently emptied every caller's response and broke ~40 call
  /// sites' assertions. The placeholder isn't a well-formed JWT, so
  /// `accessTokenIsExpired` treats it as never-expiring (can't parse an
  /// `exp` claim out of it) and `requiredTokensForRequest()` returns it
  /// without attempting a refresh.
  static func unauthenticated(server: URL, urlSession: URLSession) -> AuthenticatedHTTPClient {
    AuthenticatedHTTPClient(
      server: server,
      urlSession: urlSession,
      tokensProvider: { AuthTokens(access: "stub-access-token", refresh: "stub-refresh-token") },
      onTokensRefreshed: { _ in },
      onSignOut: {})
  }
}
