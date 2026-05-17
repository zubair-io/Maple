// src/apple/MapleQuickLook/MaplePreviewProvider.swift
import QuickLookUI
import OSLog

final class MaplePreviewProvider: QLPreviewProvider, QLPreviewingController {
    private let log = Logger(subsystem: "app.justmaple.aperture.quicklook",
                             category: "provider")

    func providePreview(for request: QLFilePreviewRequest) async throws -> QLPreviewReply {
        log.notice("stub providePreview fileURL=\(request.fileURL.path, privacy: .public)")
        throw NSError(domain: "MapleQuickLook", code: -1,
                      userInfo: [NSLocalizedDescriptionKey: "not implemented yet"])
    }
}
