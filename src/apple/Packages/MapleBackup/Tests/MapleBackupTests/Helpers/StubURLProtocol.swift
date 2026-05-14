// Tests/MapleBackupTests/Helpers/StubURLProtocol.swift
import Foundation

/// In-test URL protocol stub. Set `StubURLProtocol.stub` before each test.
///
/// `stubSession()` attaches the protocol directly to the session config via
/// `protocolClasses`, so no global `URLProtocol.registerClass` call is needed
/// or wanted — global registration leaks across test suites.
///
/// Usage:
///   StubURLProtocol.stub = .ok(json: #"{"x":1}"#)
///   let client = MyClient(session: stubSession())
internal final class StubURLProtocol: URLProtocol {
    enum Stub {
        case ok(json: String)
        case status(Int, json: String? = nil)
        case networkError(URLError.Code)
    }

    // Thread-safe accessor for `stub` — Swift tests can run in parallel
    // (Swift Testing, parallel-test schemes), and the URL loading system
    // reads `stub` from a network-private thread.
    private static let lock = NSLock()
    private nonisolated(unsafe) static var _stub: Stub?
    /// Per-test stub. Cleared in `setUp` for isolation.
    static var stub: Stub? {
        get { lock.lock(); defer { lock.unlock() }; return _stub }
        set { lock.lock(); defer { lock.unlock() }; _stub = newValue }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        switch StubURLProtocol.stub {
        case .ok(let json):
            let res = HTTPURLResponse(url: request.url!, statusCode: 200,
                                      httpVersion: "HTTP/1.1", headerFields: nil)!
            client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(json.utf8))
            client?.urlProtocolDidFinishLoading(self)
        case .status(let code, let json):
            let res = HTTPURLResponse(url: request.url!, statusCode: code,
                                      httpVersion: "HTTP/1.1", headerFields: nil)!
            client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
            if let json { client?.urlProtocol(self, didLoad: Data(json.utf8)) }
            client?.urlProtocolDidFinishLoading(self)
        case .networkError(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .none:
            let res = HTTPURLResponse(url: request.url!, statusCode: 500,
                                      httpVersion: "HTTP/1.1", headerFields: nil)!
            client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

/// Helper for building a `URLSession` that routes through `StubURLProtocol`.
internal func stubSession() -> URLSession {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubURLProtocol.self]
    return URLSession(configuration: cfg)
}
