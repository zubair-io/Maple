// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift
import Foundation

public struct LibraryRoot: Codable, Equatable, Sendable {
    public let id: String
    public let path: String         // absolute path on the server's filesystem
    public let label: String
    public let fileCount: Int

    enum CodingKeys: String, CodingKey {
        case id, path, label
        case fileCount = "file_count"
    }
}

public struct DirChild: Codable, Equatable, Sendable {
    public let name: String
    public let path: String         // absolute, server-side
    public let mtime: Date          // ISO-8601
}

public struct ImageChild: Codable, Equatable, Sendable {
    public let name: String
    public let path: String
    public let mtime: Date
    public let size: Int64
    public let ext: String
    public let assetID: String?     // server-side Mongo ObjectId; nil if not yet indexed

    enum CodingKeys: String, CodingKey {
        case name, path, mtime, size, ext
        case assetID = "id"
    }
}

public struct DirContents: Codable, Equatable, Sendable {
    public let path: String
    public let parent: String?
    public let dirs: [DirChild]
    public let images: [ImageChild]
}

public actor RemoteCatalog {
    private let http: AuthenticatedHTTPClient
    private let server: URL
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    public init(http: AuthenticatedHTTPClient, server: URL) {
        self.http = http; self.server = server
    }

    public func listFolders() async throws -> [LibraryRoot] {
        let req = URLRequest(url: server.appending(path: "/api/folders"))
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
        return try decoder.decode([LibraryRoot].self, from: data)
    }

    public func listDir(absolutePath: String) async throws -> DirContents {
        var comps = URLComponents(url: server.appending(path: "/api/fs/dir"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "path", value: absolutePath)]
        let req = URLRequest(url: comps.url!)
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
        return try decoder.decode(DirContents.self, from: data)
    }

    // Phase 1 simplification: full-body buffering. A 100MP RAW spikes ~150MB.
    // Acceptable on macOS; revisit with URLSession.download(for:) before iOS.
    public func downloadAsset(assetID: String, to localURL: URL) async throws {
        let req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/raw"))
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
        try data.write(to: localURL, options: .atomic)
    }

    private static func check2xx(_ resp: URLResponse) throws {
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw URLError(.badServerResponse) }
    }
}
