// ObservabilityController.swift
//
// Owns the native telemetry lifecycle: read the user's choice, resolve the
// self-hosted server's SigNoz config (disk-cache first, network second), and
// bootstrap swift-otel to export logs + traces direct-to-SigNoz over
// OTLP/HTTP.
//
// Ticket #713. swift-otel pinned to 1.2.1 (see Package.swift) with only the
// `OTLPHTTP` trait enabled.
//
// ── Launch contract (never block on the network) ────────────────────────────
//   start():
//     1. Load ObservabilitySettings (the user's server pick + local toggle).
//     2. If a server is selected, load the CACHED config from disk and, if it
//        is exportable (server-enabled + endpoint present) and the user's
//        local toggle is on, bootstrap swift-otel IMMEDIATELY from the cache.
//        No network, no await on I/O that can stall launch.
//     3. Kick a detached background Task that fetches a fresh config from
//        `GET /api/observability/config`, writes it to the disk cache, and —
//        if it diverged from what we bootstrapped — records that for the next
//        launch (see the one-shot-bootstrap note below).
//
// ── The one-shot-bootstrap constraint (important, not a shortcut) ───────────
//   swift-otel's `OTel.bootstrap` installs the PROCESS-GLOBAL backends:
//   `LoggingSystem.bootstrap`, `MetricsSystem.bootstrap`, and
//   `InstrumentationSystem.bootstrap`. Those global bootstraps are documented
//   as call-once-per-process — calling them a second time traps. So we CANNOT
//   literally re-bootstrap a running process when the config changes.
//
//   What we do instead is correct and honest:
//     • Bootstrap exactly once per process, using the best config available at
//       that moment (cache at launch; or the first successful fetch if there
//       was no cache).
//     • The background refresh always updates the DISK CACHE, so the next
//       launch picks up the new config. If the fresh config diverges from the
//       live one mid-session, we log it and expose `pendingConfigChange` so the
//       UI can tell the user a relaunch is needed to apply it. We never pretend
//       the change took effect live.
//
//   This is the only sane shape given a process-global telemetry backend; it
//   is not a placeholder. A future ticket that wants live re-config would need
//   swift-otel's lower-level `makeLoggingBackend`/`makeTracingBackend` plus a
//   swappable handler, which is out of scope here.

import Foundation
import Observation
import os
import OTel
import Logging
import ServiceLifecycle

private let osLog = os.Logger(subsystem: "app.justmaple.aperture", category: "observability")

/// Severity for `ObservabilityController.log(_:_:)`. Maps to swift-log levels.
public enum ObservabilityLogLevel: Sendable {
    case debug, info, notice, warning, error, critical

    fileprivate var swiftLogLevel: Logging.Logger.Level {
        switch self {
        case .debug: return .debug
        case .info: return .info
        case .notice: return .notice
        case .warning: return .warning
        case .error: return .error
        case .critical: return .critical
        }
    }
}

@MainActor
@Observable
public final class ObservabilityController {

    /// Process-wide singleton. MapleApp calls `start()` once at launch; the
    /// Settings tab reads `cachedConfig`/`status` and calls `selectServer`/
    /// `refresh`.
    public static let shared = ObservabilityController()

    // MARK: - Observable state (read by the Settings tab)

    /// The user's current pick + local toggle. Mirrors UserDefaults.
    public private(set) var settings: ObservabilitySettings

    /// The most recent resolved config we know about (from disk cache or a
    /// fresh fetch). `nil` when no server is selected or nothing is cached yet.
    public private(set) var cachedConfig: ObservabilityConfig?

    /// Wall-clock time of the last successful config fetch. `nil` until the
    /// first network refresh completes.
    public private(set) var lastRefresh: Date?

    /// Human-readable last-refresh error (nil on success). Surfaced in the UI.
    public private(set) var lastRefreshError: String?

    /// True while a `refresh()` network call is in flight.
    public private(set) var isRefreshing: Bool = false

    /// Whether swift-otel has been bootstrapped this process. Once true it
    /// stays true for the life of the process (global one-shot bootstrap).
    public private(set) var isExporting: Bool = false

    /// Set when a background refresh discovers a config that differs from the
    /// one we bootstrapped with. Because the OTel backends are process-global
    /// and can't be re-bootstrapped, the new config applies on next launch;
    /// the UI shows this as a "relaunch to apply" hint.
    public private(set) var pendingConfigChange: Bool = false

    // MARK: - Private

    /// Monotonic guard for async work. Every `selectServer` / `start` bumps
    /// this; a refresh task captures the value at kickoff and bails on
    /// completion if it has been superseded — the generation-counter pattern
    /// from best-practices.md, so a stale fetch can't clobber newer state.
    private var generation: UInt64 = 0

    /// The config swift-otel was actually bootstrapped with. Used to detect
    /// divergence on refresh. Nil until we bootstrap.
    private var bootstrappedConfig: ObservabilityConfig?

    /// Long-lived task running the OTel `Service` (the exporter run loop).
    /// Kept alive for the process lifetime; cancelled only if the app is torn
    /// down. Holding the reference prevents the service from being dropped.
    private var serviceTask: Task<Void, Never>?

    /// `true` once `start()` has run, so a defensive double-call is a no-op
    /// for the bootstrap half (the refresh half is still safe to repeat).
    private var didStart = false

    /// App-process hook that protects auth token rotation from iOS suspension.
    /// Extensions and non-iOS callers use the pass-through default.
    private var refreshExecutor: any AuthenticatedRefreshExecutor =
        DirectAuthenticatedRefreshExecutor()

    private init() {
        self.settings = ObservabilitySettings.load() ?? .defaults
    }

    // MARK: - Lifecycle

    /// Called once at app launch. Reads cached config and bootstraps the
    /// exporter synchronously from disk (no network), then kicks a background
    /// refresh. Safe to call more than once — only the first call bootstraps.
    public func start(
        refreshExecutor: any AuthenticatedRefreshExecutor =
            DirectAuthenticatedRefreshExecutor()
    ) {
        // Adopt the executor before the didStart guard: a `selectServer` that
        // beat `start()` to the punch has already kicked a refresh, and every
        // later refresh on this controller should be protected regardless of
        // which call won.
        self.refreshExecutor = refreshExecutor

        guard !didStart else {
            osLog.debug("start() called again — already started, ignoring")
            return
        }
        didStart = true

        guard let server = selectedServerURL else {
            osLog.info("observability: no server selected — telemetry inactive")
            return
        }

        // 1. Disk cache → immediate bootstrap (never touches the network).
        if let cached = ObservabilityConfigCache.load(server: server) {
            cachedConfig = cached
            osLog.info("observability: loaded cached config for \(server.host ?? server.absoluteString, privacy: .public) (enabled=\(cached.enabled, privacy: .public) endpointSet=\(cached.normalizedEndpoint != nil, privacy: .public))")
            bootstrapIfPossible(with: cached)
        } else {
            osLog.info("observability: no cached config for \(server.host ?? server.absoluteString, privacy: .public) — will fetch in background")
        }

        // 2. Background refresh — updates the cache and (if nothing was
        //    bootstrapped yet) bootstraps from the first successful fetch.
        Task { await refresh() }
    }

    // MARK: - User actions (called by the Settings tab)

    /// Change which server provides the SigNoz config. Persists the choice,
    /// updates observable state from that server's disk cache immediately, and
    /// kicks a background refresh. Does NOT (and cannot) re-bootstrap a
    /// running exporter — if a different live config results, it applies on
    /// next launch.
    public func selectServer(_ url: URL?) {
        generation &+= 1
        let urlString = url?.absoluteString ?? ""
        settings.serverURL = urlString
        settings.save()

        if let server = url {
            cachedConfig = ObservabilityConfigCache.load(server: server)
            // If we haven't bootstrapped yet and we have a usable cached
            // config + the user's toggle is on, bootstrap now.
            if let cached = cachedConfig, !isExporting {
                bootstrapIfPossible(with: cached)
            }
            // Refresh divergence is meaningful only against what we actually
            // bootstrapped with; recompute it.
            recomputePendingChange()
        } else {
            cachedConfig = nil
            lastRefresh = nil
            lastRefreshError = nil
            recomputePendingChange()
        }

        Task { await refresh() }
    }

    /// Toggle this device's local opt-in. Persists, and bootstraps if turning
    /// on reveals a usable cached config and nothing is exporting yet.
    public func setEnabled(_ enabled: Bool) {
        settings.enabled = enabled
        settings.save()
        if enabled, !isExporting, let cached = cachedConfig {
            bootstrapIfPossible(with: cached)
        }
    }

    /// Fetch a fresh config from the selected server, persist it to the disk
    /// cache, and update observable state. Bootstraps from the result if we
    /// haven't bootstrapped yet; otherwise records divergence for next launch.
    public func refresh() async {
        guard let server = selectedServerURL else { return }
        let gen = generation
        isRefreshing = true
        lastRefreshError = nil
        defer { isRefreshing = false }

        do {
            let client = try await makeClient(for: server)
            let fresh = try await client.fetchConfig()

            // Superseded by a newer selectServer/start while we were in
            // flight — drop this result so we don't clobber newer state.
            guard gen == generation, selectedServerURL == server else {
                osLog.debug("observability: refresh superseded — discarding result")
                return
            }

            ObservabilityConfigCache.save(fresh, server: server)
            cachedConfig = fresh
            lastRefresh = Date()
            osLog.info("observability: refreshed config for \(server.host ?? server.absoluteString, privacy: .public) (enabled=\(fresh.enabled, privacy: .public) traces=\(fresh.tracesEnabled, privacy: .public) logs=\(fresh.logsEnabled, privacy: .public))")

            if !isExporting {
                // First config we've seen this process — bootstrap from it.
                bootstrapIfPossible(with: fresh)
            } else {
                recomputePendingChange()
            }
        } catch {
            guard gen == generation else { return }
            lastRefreshError = error.localizedDescription
            osLog.error("observability: refresh failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Telemetry sinks (bridge OSLog/error reporting into OTel)

    /// Record an error as an OTel log record at `.error`. No-op until the
    /// exporter is bootstrapped. The error's description is included; do not
    /// pass secrets in `context`.
    public func recordError(_ error: Error, context: String? = nil) {
        guard isExporting else { return }
        let otelLogger = Logging.Logger(label: "maple-apple.error")
        var metadata: Logging.Logger.Metadata = [
            "error.type": .string(String(reflecting: type(of: error))),
        ]
        if let context { metadata["context"] = .string(context) }
        otelLogger.error("\(error.localizedDescription)", metadata: metadata)
    }

    /// Emit an OTel log record at `level`. No-op until bootstrapped. Routed
    /// through swift-log, which OTel has taken over as the global backend.
    public func log(_ level: ObservabilityLogLevel, _ message: String) {
        guard isExporting else { return }
        let otelLogger = Logging.Logger(label: "maple-apple")
        otelLogger.log(level: level.swiftLogLevel, "\(message)")
    }

    // MARK: - Bootstrap

    /// Bootstrap swift-otel from `config` if (a) we haven't already this
    /// process, (b) the user's local toggle is on, and (c) the config is
    /// exportable (server-enabled + endpoint present). Otherwise no-op.
    private func bootstrapIfPossible(with config: ObservabilityConfig) {
        guard !isExporting else { return }
        guard settings.enabled else {
            osLog.info("observability: local toggle off — not bootstrapping")
            return
        }
        guard config.isExportable else {
            osLog.info("observability: config not exportable (enabled=\(config.enabled, privacy: .public) endpointSet=\(config.normalizedEndpoint != nil, privacy: .public)) — not bootstrapping")
            return
        }
        // Telemetry exports through the Maple API's OTLP proxy on the selected
        // server — NOT direct to SigNoz. We need the server base URL (to build
        // the proxy endpoint) and the access token (to authenticate to Maple).
        guard let server = selectedServerURL else {
            osLog.info("observability: no server selected — not bootstrapping")
            return
        }
        guard let tokens = try? TokenStore.load(server: server), !tokens.access.isEmpty else {
            // Not signed in yet. The background refresh will retry; once signed
            // in, a later config apply / relaunch bootstraps with a token.
            osLog.info("observability: no access token for \(server.host ?? server.absoluteString, privacy: .public) — not bootstrapping (will retry)")
            return
        }

        let exporter = OTelExporterConfig(
            config: config, server: server, accessToken: tokens.access)
        let otelConfiguration: OTel.Configuration
        do {
            otelConfiguration = try exporter.makeConfiguration()
        } catch {
            osLog.error("observability: failed to build OTel configuration: \(error.localizedDescription, privacy: .public)")
            return
        }

        let service: any Service
        do {
            service = try OTel.bootstrap(configuration: otelConfiguration)
        } catch {
            // bootstrap throws if all signals are disabled or it was already
            // called — both are recoverable: just stay inactive.
            osLog.error("observability: OTel.bootstrap failed: \(error.localizedDescription, privacy: .public)")
            return
        }

        // Run the exporter service for the process lifetime on a detached
        // task so the run loop never hops back onto the main actor between
        // awaits. ServiceGroup gives it a clean run/shutdown loop; we hold the
        // task reference so it isn't dropped. swift-otel re-exports
        // ServiceLifecycle (ServiceGroup / Service) via `import OTel`.
        let group = ServiceGroup(
            services: [service],
            logger: Logging.Logger(label: "maple-apple.otel"))
        serviceTask = Task.detached {
            do {
                try await group.run()
            } catch {
                osLog.error("observability: OTel service group exited with error: \(error.localizedDescription, privacy: .public)")
            }
        }

        isExporting = true
        bootstrappedConfig = config
        pendingConfigChange = false
        osLog.info("observability: exporter bootstrapped via Maple proxy on \(server.host ?? server.absoluteString, privacy: .public) → SigNoz \(config.normalizedEndpoint ?? "<none>", privacy: .public) (service.namespace=\(config.serviceNamespace, privacy: .public))")
    }

    /// Recompute whether the live (cached) config diverges from the one we
    /// bootstrapped. Only meaningful once we're exporting.
    private func recomputePendingChange() {
        guard isExporting, let bootstrapped = bootstrappedConfig else {
            pendingConfigChange = false
            return
        }
        let diverged = cachedConfig != bootstrapped
        if diverged && !pendingConfigChange {
            osLog.notice("observability: live config diverged from bootstrapped config — relaunch to apply")
        }
        pendingConfigChange = diverged
    }

    // MARK: - Helpers

    private var selectedServerURL: URL? {
        guard !settings.serverURL.isEmpty else { return nil }
        return URL(string: settings.serverURL)
    }

    /// Build an authenticated ObservabilityConfigClient for `server`,
    /// restoring Keychain tokens if needed. Mirrors CloudFoldersListing.client
    /// in the app module, but lives here in MapleCore so the controller has no
    /// app-module dependency. Throws a user-facing NSError when not signed in.
    private func makeClient(for server: URL) async throws -> ObservabilityConfigClient {
        let session = AuthSession(server: server, client: AuthClient(server: server))
        if !session.isSignedIn { await session.bootstrapAndRestore() }
        guard session.isSignedIn else {
            throw NSError(
                domain: "ObservabilityConfigClient",
                code: 401,
                userInfo: [NSLocalizedDescriptionKey:
                    "Not signed in to \(server.host ?? server.absoluteString). Sign in via the Cloud tab."])
        }
        let httpClient = AuthenticatedHTTPClient(
            server: server,
            urlSession: .shared,
            tokensProvider: { try? TokenStore.load(server: server) },
            // Mirror rotations into the File Provider store too — see CloudTokenPersistence.
            onTokensRefreshed: { try CloudTokenPersistence.persistRotated($0, server: server) },
            onSignOut: { CloudTokenPersistence.clear(server: server) },
            refreshExecutor: refreshExecutor)
        return ObservabilityConfigClient(server: server, httpClient: httpClient)
    }
}

// MARK: - OTelExporterConfig

/// Single, isolated translation point from Maple's `ObservabilityConfig` (our
/// wire DTO) to swift-otel's `OTel.Configuration`. All knowledge of the
/// swift-otel 1.2.1 API lives here so the integration is auditable against the
/// docs in one place.
///
/// Telemetry is exported through the Maple API's authenticated OTLP proxy
/// (`<server>/api/observability/otlp`) — NOT direct to SigNoz. The proxy injects
/// the SigNoz ingestion key server-side, so the app authenticates to Maple with
/// its access token (`Authorization: Bearer`) instead of carrying the SigNoz key.
///
/// API reference (swift-otel 1.2.1, `Sources/OTel/OTelAPI/OTel+Configuration.swift`):
///   • `OTel.Configuration.default` — base value.
///   • `.serviceName: String`, `.resourceAttributes: [String: String]`.
///   • `.traces` / `.logs` / `.metrics` sub-configs, each with `.enabled: Bool`,
///     `.exporter: ExporterSelection` (`.otlp` / `.none`), and
///     `.otlpExporter: OTLPExporterConfiguration`.
///   • `.traces.sampler` — `.parentBasedTraceIDRatio(ratio:) -> Self?`.
///   • `OTLPExporterConfiguration.endpoint: String` (base; the exporter
///     appends `/v1/traces` and `/v1/logs` itself — so the base must have NO
///     trailing slash), `.protocol: Protocol` (`.httpProtobuf`),
///     `.headers: [(String, String)]`, `.compression: Compression`.
///
/// Auth note: the bearer is captured at bootstrap. The access token TTL is long
/// (30 days) — comfortably longer than a process lifetime — and the controller
/// re-bootstraps on each launch, so a static header is sufficient here; there's
/// no in-process token rotation to track (unlike the web client).
struct OTelExporterConfig {
    let config: ObservabilityConfig
    /// The paired self-hosted server whose OTLP proxy receives the export.
    let server: URL
    /// Maple access token, sent as `Authorization: Bearer` to the proxy.
    let accessToken: String

    enum BuildError: Error, CustomStringConvertible {
        case noEndpoint
        var description: String {
            switch self {
            case .noEndpoint: return "observability config has no endpoint"
            }
        }
    }

    /// Map our DTO onto swift-otel's `OTel.Configuration`, configured for
    /// OTLP/HTTP+protobuf through the Maple proxy. Enables only the signals the
    /// server turned on. Caller must have already verified `config.isExportable`.
    func makeConfiguration() throws -> OTel.Configuration {
        // `endpoint` must be present for telemetry to be meaningful (it's where
        // the SERVER forwards), even though the app posts to the proxy. Gate on
        // it so a config with no SigNoz target stays a no-op.
        guard config.normalizedEndpoint != nil else {
            throw BuildError.noEndpoint
        }

        // The proxy base. swift-otel appends `/v1/traces` and `/v1/logs`, so we
        // give it `<server>/api/observability/otlp` with no trailing slash.
        let proxyBase =
            server.appending(path: "/api/observability/otlp").absoluteString
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)

        var otel = OTel.Configuration.default
        otel.serviceName = "maple-apple"
        otel.resourceAttributes = [
            "service.namespace": config.serviceNamespace,
        ]

        // Shared per-signal OTLP/HTTP exporter settings: proxy base (no trailing
        // slash), HTTP+protobuf, and the Maple bearer (the proxy injects the
        // SigNoz key itself; we never carry it).
        let headers: [(String, String)] = [("Authorization", "Bearer \(accessToken)")]

        func applyExporter(_ exporter: inout OTel.Configuration.OTLPExporterConfiguration) {
            exporter.endpoint = proxyBase
            exporter.protocol = .httpProtobuf
            exporter.headers = headers
        }

        // ── Traces ──
        if config.tracesEnabled {
            otel.traces.enabled = true
            otel.traces.exporter = .otlp
            applyExporter(&otel.traces.otlpExporter)
            // Parent-based trace-ID-ratio sampler honours the server's ratio.
            // `parentBasedTraceIDRatio(ratio:)` returns nil for out-of-range
            // input; clamp to [0, 1] and fall back to always-on if somehow nil.
            let ratio = min(max(config.sampleRatio, 0.0), 1.0)
            if let sampler = OTel.Configuration.TracesConfiguration.SamplerConfiguration
                .parentBasedTraceIDRatio(ratio: ratio) {
                otel.traces.sampler = sampler
            } else {
                otel.traces.sampler = .parentBasedAlwaysOn
            }
        } else {
            otel.traces.enabled = false
        }

        // ── Logs ──
        if config.logsEnabled {
            otel.logs.enabled = true
            otel.logs.exporter = .otlp
            applyExporter(&otel.logs.otlpExporter)
        } else {
            otel.logs.enabled = false
        }

        // ── Metrics ── Maple does not export metrics from the native app in
        // this ticket; honour the server flag but default off.
        if config.metricsEnabled {
            otel.metrics.enabled = true
            otel.metrics.exporter = .otlp
            applyExporter(&otel.metrics.otlpExporter)
        } else {
            otel.metrics.enabled = false
        }

        return otel
    }
}
