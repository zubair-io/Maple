// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift
import Foundation

public enum FileProviderIdentifier: Equatable, Hashable, Sendable {
    case asset(String)
    case folder(folderID: String, relativePath: String)

    public enum DecodeError: Error { case invalidPrefix, malformedFolder, badBase64 }

    public var rawValue: String {
        switch self {
        case .asset(let id):
            return "asset/\(id)"
        case .folder(let folderID, let relativePath):
            return "folder/\(folderID):\(Self.b64urlEncode(relativePath))"
        }
    }

    public init(rawValue: String) throws {
        if let id = rawValue.dropPrefixIfPresent("asset/") {
            self = .asset(String(id))
            return
        }
        if let body = rawValue.dropPrefixIfPresent("folder/") {
            guard let colon = body.firstIndex(of: ":") else { throw DecodeError.malformedFolder }
            let folderID = String(body[..<colon])
            let encoded = String(body[body.index(after: colon)...])
            guard let path = Self.b64urlDecode(encoded) else { throw DecodeError.badBase64 }
            self = .folder(folderID: folderID, relativePath: path)
            return
        }
        throw DecodeError.invalidPrefix
    }

    private static func b64urlEncode(_ s: String) -> String {
        let data = Data(s.utf8)
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func b64urlDecode(_ s: String) -> String? {
        if s.isEmpty { return "" }
        var padded = s.replacingOccurrences(of: "-", with: "+")
                      .replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded.append("=") }
        guard let data = Data(base64Encoded: padded),
              let s = String(data: data, encoding: .utf8) else { return nil }
        return s
    }
}

private extension String {
    func dropPrefixIfPresent(_ prefix: String) -> Substring? {
        guard hasPrefix(prefix) else { return nil }
        return dropFirst(prefix.count)
    }
}
