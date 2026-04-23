// SelfHostedSource.swift — URLSession-backed adapter for the Bun API.
//
// Talks to the self-hosted Maple server described in spec §07. The server
// exposes REST routes under `/api/...`; this actor maps `ImageSource`
// methods onto those routes. No shared code with the server — the DTOs
// here are hand-rolled minimally to match the wire format.
//
// Auth: a bearer token issued during pairing. Stored in Keychain via
// `SelfHostedCredentialStore` (see SelfHostedCredentialStore.swift).

import Foundation

// MARK: - SelfHostedSource

public actor SelfHostedSource {

    // MARK: State

    private let baseURL: URL
    private var token: String?
    private let session: URLSession

    /// Injectable session for tests. Production callers should rely on the
    /// convenience initialiser which picks `.shared`.
    public init(baseURL: URL, token: String?, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    public func setToken(_ token: String?) {
        self.token = token
    }

    // MARK: Request helpers

    private func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(url: baseURL.appendingPathComponent(path),
                                       resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        return components.url!
    }

    private func authorize(_ request: inout URLRequest) {
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }

    private func getData(_ url: URL) async throws -> Data {
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        authorize(&req)
        let (data, response) = try await session.data(for: req)
        try Self.throwIfHTTPError(response, data: data)
        return data
    }

    private func getJSON<T: Decodable>(_ url: URL, as type: T.Type) async throws -> T {
        let data = try await getData(url)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func putJSON<T: Encodable>(_ url: URL, body: T) async throws {
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        authorize(&req)
        req.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: req)
        try Self.throwIfHTTPError(response, data: data)
    }

    private static func throwIfHTTPError(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            throw SelfHostedError.httpStatus(http.statusCode,
                                             String(data: data, encoding: .utf8) ?? "")
        }
    }

    // MARK: DTOs (minimal, wire-format-compatible with spec §07)

    struct FolderDTO: Decodable {
        let id: String
        let path: String
        let label: String?
    }

    struct ImageDTO: Decodable {
        let id: String
        let file: String
        let capturedAt: String?   // ISO-8601; we use it only for ordering
    }

    struct AdjustmentDTO: Encodable {
        let adj: AdjustmentModel
    }

    struct RatingDTO: Encodable {
        let rating: Int
    }

    struct FlagDTO: Encodable {
        let flag: String
    }
}

// MARK: - ImageSource conformance

extension SelfHostedSource: ImageSource {

    public func images() async throws -> [ImageRef] {
        let folders: [FolderDTO] = try await getJSON(
            url("api/folders"), as: [FolderDTO].self)

        var all: [(ImageDTO, String)] = []  // (image, capturedAt-sortkey)
        for folder in folders {
            let list: [ImageDTO] = try await getJSON(
                url("api/folders/\(folder.id)/images"),
                as: [ImageDTO].self)
            for image in list {
                all.append((image, image.capturedAt ?? image.file))
            }
        }
        // Sort by capturedAt descending — ISO-8601 strings sort correctly.
        all.sort { $0.1 > $1.1 }
        return all.map { (dto, _) in
            ImageRef(id: dto.id, displayName: dto.file, url: nil)
        }
    }

    public func thumb(for ref: ImageRef) async throws -> Data? {
        do {
            return try await getData(url("api/images/\(ref.id)/thumb"))
        } catch SelfHostedError.httpStatus(let code, _) where code == 404 {
            return nil
        }
    }

    public func preview(for ref: ImageRef) async throws -> Data? {
        do {
            return try await getData(url("api/images/\(ref.id)/preview"))
        } catch SelfHostedError.httpStatus(let code, _) where code == 404 {
            return nil
        }
    }

    public func rawBytes(for ref: ImageRef) async throws -> Data {
        // Range-streamed fetch (Path A). We still return a single `Data` —
        // the Rust decoder consumes a complete buffer — but we read the body
        // off the socket via `URLSession.bytes`, gathering 64 KB chunks as we
        // go. Latency-to-first-byte is unchanged, but:
        //   - the server can `read()` from disk while the client reads from
        //     the socket (saves a full upload-latency on slow networks);
        //   - cancellation propagates to the socket promptly;
        //   - we get back-pressure for free, instead of buffering the whole
        //     50–200 MB in URLSession's internal cache before handing it up.
        //
        // The `Range: bytes=0-` header signals to the server that we
        // understand 206 Partial Content; an HTTP/1.1-compliant server will
        // respond with either a 200 (no range support — fine, fall through)
        // or a 206 covering the full body. We treat both as success.
        //
        // TODO(api-range): the Bun api at src/api/src/routes/images.ts does
        // not (yet) advertise `Accept-Ranges: bytes` for /raw; this client is
        // forward-compatible for when it does.
        let endpoint = url("api/images/\(ref.id)/raw")
        var req = URLRequest(url: endpoint)
        req.httpMethod = "GET"
        req.setValue("bytes=0-", forHTTPHeaderField: "Range")
        authorize(&req)

        do {
            let (asyncBytes, response) = try await session.bytes(for: req)
            if let http = response as? HTTPURLResponse {
                let code = http.statusCode
                guard (200..<300).contains(code) else {
                    // Drain enough body for an error message, then throw.
                    var body = Data()
                    var iter = asyncBytes.makeAsyncIterator()
                    while body.count < 4096, let byte = try await iter.next() {
                        body.append(byte)
                    }
                    throw SelfHostedError.httpStatus(
                        code, String(data: body, encoding: .utf8) ?? ""
                    )
                }
            }

            // Capacity hint from Content-Length so we don't reallocate as the
            // body streams in. Header is the only remaining-body length when
            // the server returns 206 — for 200 it's the total body size.
            let capacity: Int = (response as? HTTPURLResponse)
                .flatMap { $0.value(forHTTPHeaderField: "Content-Length") }
                .flatMap(Int.init) ?? 0
            var data = Data()
            if capacity > 0 { data.reserveCapacity(capacity) }

            // Gather into 64 KB chunks. `URLSession.AsyncBytes` exposes
            // single-byte iteration only; the chunking is manual but cheap
            // because Data's append-Sequence path takes the bulk-copy fast
            // path when the source is contiguous.
            let chunkBytes = 64 * 1024
            var chunk = [UInt8]()
            chunk.reserveCapacity(chunkBytes)
            for try await byte in asyncBytes {
                chunk.append(byte)
                if chunk.count >= chunkBytes {
                    data.append(chunk, count: chunk.count)
                    chunk.removeAll(keepingCapacity: true)
                }
                try Task.checkCancellation()
            }
            if !chunk.isEmpty {
                data.append(chunk, count: chunk.count)
            }
            return data
        } catch let urlErr as URLError where urlErr.code == .cancelled {
            throw urlErr
        } catch is CancellationError {
            throw CancellationError()
        } catch SelfHostedError.httpStatus(let code, _) where code == 416 {
            // Server doesn't understand `Range: bytes=0-`. Fall back to the
            // one-shot path so callers still get bytes.
            return try await getData(endpoint)
        }
    }

    public func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
        // adj (the continuous knobs) goes to PUT /adj; rating + flag are
        // promoted to their own routes so the server can update Mongo
        // without round-tripping a full adjustment payload.
        try await putJSON(url("api/images/\(ref.id)/adj"),
                          body: AdjustmentDTO(adj: sidecar.model))
        try await putJSON(url("api/images/\(ref.id)/rating"),
                          body: RatingDTO(rating: sidecar.culling.stars))
        try await putJSON(url("api/images/\(ref.id)/flag"),
                          body: FlagDTO(flag: sidecar.culling.flag.rawValue))
    }

    public func search(_ query: SearchQuery) async throws -> [ImageRef]? {
        var items: [URLQueryItem] = [URLQueryItem(name: "q", value: query.q)]
        if let filter = query.filter { items.append(URLQueryItem(name: "filter", value: filter)) }
        if let near = query.near { items.append(URLQueryItem(name: "near", value: near)) }
        if let limit = query.limit { items.append(URLQueryItem(name: "limit", value: String(limit))) }
        if let offset = query.offset { items.append(URLQueryItem(name: "offset", value: String(offset))) }
        let hits: [ImageDTO] = try await getJSON(
            url("api/search", query: items), as: [ImageDTO].self)
        return hits.map { ImageRef(id: $0.id, displayName: $0.file, url: nil) }
    }
}

// MARK: - SelfHostedError

public enum SelfHostedError: Error, LocalizedError, Equatable {
    case httpStatus(Int, String)

    public var errorDescription: String? {
        switch self {
        case .httpStatus(let code, let body):
            return "Self-hosted API returned HTTP \(code): \(body)"
        }
    }
}

// SelfHostedCredentialStore now lives in its own file — see
// SelfHostedCredentialStore.swift for the Keychain-backed implementation.
