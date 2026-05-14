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
///
/// Inspect all recorded requests after the test via
/// `StubURLProtocol.recordedRequests`. Call `StubURLProtocol.clearRecording()`
/// in setUp if you need a clean slate per test.
internal final class StubURLProtocol: URLProtocol {
    enum Stub {
        case ok(json: String)
        case status(Int, json: String? = nil)
        case networkError(URLError.Code)
        /// Respond with different stubs in sequence. When the list is
        /// exhausted, falls back to 500.
        case sequence([Stub])
    }

    // Thread-safe accessors — Swift tests can run in parallel (Swift Testing,
    // parallel-test schemes), and the URL loading system reads from a
    // network-private thread.
    private static let lock = NSLock()
    private nonisolated(unsafe) static var _stub: Stub?
    private nonisolated(unsafe) static var _recordedRequests: [URLRequest] = []
    private nonisolated(unsafe) static var _sequenceIndex = 0

    /// Per-test stub. Cleared in `setUp` for isolation.
    static var stub: Stub? {
        get { lock.lock(); defer { lock.unlock() }; return _stub }
        set { lock.lock(); defer { lock.unlock() }; _stub = newValue }
    }

    /// All requests seen since the last `clearRecording()`.
    static var recordedRequests: [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return _recordedRequests
    }

    /// Reset the recording and sequence index. Call in setUp for isolation.
    static func clearRecording() {
        lock.lock(); defer { lock.unlock() }
        _recordedRequests = []
        _sequenceIndex = 0
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // Record the incoming request (with body snapshot) for assertions.
        var recorded = request
        // URLProtocol strips httpBody; recover it from httpBodyStream if present.
        if request.httpBody == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
            defer { buf.deallocate() }
            while stream.hasBytesAvailable {
                let n = stream.read(buf, maxLength: 4096)
                if n <= 0 { break }
                data.append(buf, count: n)
            }
            stream.close()
            recorded.httpBody = data
        }
        Self.lock.lock()
        Self._recordedRequests.append(recorded)
        Self.lock.unlock()

        let effectiveStub = Self.resolveStub()
        apply(stub: effectiveStub)
    }

    private static func resolveStub() -> Stub {
        lock.lock(); defer { lock.unlock() }
        switch _stub {
        case .sequence(let list):
            let idx = _sequenceIndex
            _sequenceIndex += 1
            if idx < list.count { return list[idx] }
            return .status(500)
        case .some(let s):
            return s
        case .none:
            return .status(500)
        }
    }

    private func apply(stub: Stub) {
        switch stub {
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
        case .sequence:
            // Already resolved above — should never recurse here.
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
