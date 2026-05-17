// src/apple/MapleQuickLook/MaplePreviewProvider.swift
import QuickLookUI
import UniformTypeIdentifiers
import MapleCore
import OSLog

/// macOS Quick Look provider for files surfaced by the Maple File
/// Provider extension. When the user hits spacebar on a RAW in Finder,
/// QuickLook hands us the local cache URL of the materialized file (or
/// the placeholder, depending on FP state). We resolve it back to a
/// `(domain, assetID)` pair through the shared `FileProviderMetaStore`
/// and fetch the pre-baked JPEG preview from
/// `GET /api/assets/<id>/thumb` — orders of magnitude cheaper than
/// decoding a 40–150 MB RAW.
///
/// Any failure throws an error; the Quick Look runtime treats a throw
/// as "fall back to the system default preview" which, for a RAW, means
/// the slow path that materializes and decodes the full file. That is
/// the desired degradation — never worse than today's behaviour.
final class MaplePreviewProvider: QLPreviewProvider, QLPreviewingController {
    private let log = Logger(subsystem: "app.justmaple.aperture.quicklook",
                             category: "provider")
    private let metaStore: FileProviderMetaStore?
    private let config: FileProviderConfig
    /// One URLSession for the lifetime of the provider instance. Cheap
    /// to share across requests — every spacebar press in Finder reuses
    /// the same connection pool, TLS session resumption, and DNS cache.
    /// `AuthenticatedHTTPClient` and `RemoteCatalog` are still
    /// per-request because they're per-domain (server URL + tokens).
    private let urlSession: URLSession

    override init() {
        self.metaStore = try? FileProviderMetaStore()
        self.config = FileProviderConfig()
        self.urlSession = URLSession(configuration: .default)
        super.init()
    }

    func providePreview(for request: QLFilePreviewRequest) async throws -> QLPreviewReply {
        let fileURL = request.fileURL
        let basename = fileURL.lastPathComponent
        log.notice("providePreview basename=\(basename, privacy: .public)")

        // 0. XMP sidecars don't have an image preview — let the system
        //    show the raw text/XML. Bail before touching the meta store
        //    or domain config: this is the expected case for every .xmp
        //    surfaced through the FP, not an error worth investigating.
        //    `FileProviderExtension.fetchContents` preserves the `.xmp`
        //    suffix when materializing sidecars (RAWs stay extensionless)
        //    so this single basename check is a reliable discriminator.
        if QuickLookResolver.isSidecarBasename(basename) {
            throw Self.fallbackError("xmp sidecar — no jpeg preview")
        }

        // 1. Resolve the FP domain that owns the cached file.
        let configuredDomains = Set(config.allDomains().map { $0.domainIdentifier })
        guard let domainID = QuickLookResolver.resolveDomain(from: fileURL,
                                                             configured: configuredDomains) else {
            log.notice("no FP domain matches \(fileURL.path, privacy: .public) — falling back")
            throw Self.fallbackError("no FP domain match")
        }

        // 2. Look up (domain, basename) -> assetID via the shared meta store.
        guard let store = metaStore else {
            log.notice("meta store unavailable — falling back")
            throw Self.fallbackError("meta store unavailable")
        }
        let row: FileProviderMetaStore.Row
        do {
            guard let r = try store.get(domain: domainID, localBasename: basename) else {
                log.notice("no meta row for basename=\(basename, privacy: .public) in domain \(domainID, privacy: .public) — falling back")
                throw Self.fallbackError("no meta row")
            }
            row = r
        } catch let err as FileProviderMetaStore.StoreError {
            log.notice("meta store get failed: \(String(describing: err), privacy: .public) — falling back")
            throw Self.fallbackError("meta store error")
        }

        // 3. Resolve the per-domain server URL + auth tokens.
        guard let cfg = config.load(domain: domainID) else {
            log.notice("domain config missing for \(domainID, privacy: .public) — falling back")
            throw Self.fallbackError("domain config missing")
        }
        let tokensStore = FileProviderTokensStore()
        let http = AuthenticatedHTTPClient(
            server: cfg.serverURL,
            urlSession: urlSession,
            tokensProvider: { tokensStore.load(domain: domainID) },
            onTokensRefreshed: { tokensStore.save($0, domain: domainID) },
            onSignOut: { tokensStore.remove(domain: domainID) }
        )
        let catalog = RemoteCatalog(http: http, server: cfg.serverURL)

        // 4. Fetch the JPEG preview.
        let bytes: Data
        do {
            bytes = try await catalog.getThumb(assetID: row.assetID)
        } catch {
            log.notice("thumb fetch failed: \(error.localizedDescription, privacy: .public) — falling back")
            throw Self.fallbackError("thumb fetch failed")
        }

        // 5. Build the reply. `contentSize` is advisory; QL re-reads the
        //    actual dimensions from the JPEG header and re-aspects on
        //    display. The 1024-square placeholder is conventional.
        let reply = QLPreviewReply(
            dataOfContentType: .jpeg,
            contentSize: CGSize(width: 1024, height: 1024)
        ) { _ in bytes }
        return reply
    }

    /// Any throw from `providePreview` causes the Quick Look runtime to
    /// fall back to the system-default preview path. We always throw the
    /// same NSError so log triage is easy.
    private static func fallbackError(_ reason: String) -> NSError {
        NSError(
            domain: "app.justmaple.aperture.quicklook",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: reason],
        )
    }
}
