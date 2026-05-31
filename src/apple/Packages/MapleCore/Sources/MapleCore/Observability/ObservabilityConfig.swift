// ObservabilityConfig.swift
//
// DTO for `GET /api/observability/config` — the resolved SigNoz /
// OpenTelemetry runtime config the self-hosted server hands to authenticated
// clients. The app does NOT ship direct to SigNoz: it exports through the Maple
// API's OTLP proxy (`POST /api/observability/otlp/v1/*`), which injects the
// SigNoz ingestion key server-side. The key value is therefore never sent to
// the client — the response reports only `ingestion_key_set`.
//
// Wire shape (snake_case on the wire; mapped via CodingKeys):
//
//   {
//     "enabled": true,
//     "endpoint": "https://signoz.example.com:4318",   // may be null; display/gating only
//     "ingestion_key_set": true,                        // key value never sent
//     "service_namespace": "maple",
//     "traces_enabled": true,
//     "logs_enabled": true,
//     "metrics_enabled": false,
//     "sample_ratio": 1.0,
//     "source": { "endpoint": "db|unset", "...": "..." }
//   }
//
// `endpoint` may be null when the operator hasn't configured a SigNoz target —
// in that case telemetry is a no-op. The app's exporter posts to the Maple
// proxy base (`<server>/api/observability/otlp`), to which swift-otel appends
// `/v1/traces` and `/v1/logs`; the server forwards to `endpoint/v1/*`.
//
// The `source` map is diagnostic provenance ("which layer supplied each
// field": db override, env fallback, or unset). It's decoded loosely as
// `[String: String]` because its keys are open-ended and the native side only
// surfaces it for display, never branches on it.

import Foundation

public struct ObservabilityConfig: Codable, Equatable, Sendable {

    /// Master switch. When false the server is telling us to ship nothing.
    public var enabled: Bool

    /// SigNoz OTLP/HTTP base URL the SERVER ultimately forwards to. Display +
    /// gating only on the client — the app exports through the Maple proxy, not
    /// here. `nil` → telemetry is a no-op (the operator hasn't configured one).
    public var endpoint: String?

    /// Whether a SigNoz ingestion key is configured server-side. The key value
    /// is NEVER sent to the client — the Maple OTLP proxy injects it. The app
    /// authenticates to Maple with its access token instead.
    public var ingestionKeySet: Bool

    /// `service.namespace` resource attribute. Groups every Maple signal
    /// (API, web, native) under one logical service tree in SigNoz.
    public var serviceNamespace: String

    /// Per-signal toggles. The server's defaults are traces/logs on,
    /// metrics off — but we honour whatever it sends.
    public var tracesEnabled: Bool
    public var logsEnabled: Bool
    public var metricsEnabled: Bool

    /// Trace sample ratio in [0, 1]. 1.0 = sample every trace.
    public var sampleRatio: Double

    /// Diagnostic provenance from the server: which layer supplied each
    /// field (`"db"`, `"env"`, `"unset"`). Display-only. Decoded loosely
    /// since the key set is open-ended.
    public var source: [String: String]

    public init(
        enabled: Bool,
        endpoint: String?,
        ingestionKeySet: Bool,
        serviceNamespace: String,
        tracesEnabled: Bool,
        logsEnabled: Bool,
        metricsEnabled: Bool,
        sampleRatio: Double,
        source: [String: String] = [:]
    ) {
        self.enabled = enabled
        self.endpoint = endpoint
        self.ingestionKeySet = ingestionKeySet
        self.serviceNamespace = serviceNamespace
        self.tracesEnabled = tracesEnabled
        self.logsEnabled = logsEnabled
        self.metricsEnabled = metricsEnabled
        self.sampleRatio = sampleRatio
        self.source = source
    }

    private enum CodingKeys: String, CodingKey {
        case enabled
        case endpoint
        case ingestionKeySet = "ingestion_key_set"
        case serviceNamespace = "service_namespace"
        case tracesEnabled = "traces_enabled"
        case logsEnabled = "logs_enabled"
        case metricsEnabled = "metrics_enabled"
        case sampleRatio = "sample_ratio"
        case source
    }

    // Defensive decode: the server always sends the resolved shape with all
    // keys present, but tolerate a sparse/forward-compatible payload (an
    // older or partial server) by defaulting any missing field. `endpoint` is
    // explicitly nullable on the wire; `ingestion_key_set` is a plain bool.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        self.endpoint = try c.decodeIfPresent(String.self, forKey: .endpoint)
        self.ingestionKeySet = try c.decodeIfPresent(Bool.self, forKey: .ingestionKeySet) ?? false
        self.serviceNamespace = try c.decodeIfPresent(String.self, forKey: .serviceNamespace) ?? "maple"
        self.tracesEnabled = try c.decodeIfPresent(Bool.self, forKey: .tracesEnabled) ?? true
        self.logsEnabled = try c.decodeIfPresent(Bool.self, forKey: .logsEnabled) ?? true
        self.metricsEnabled = try c.decodeIfPresent(Bool.self, forKey: .metricsEnabled) ?? false
        self.sampleRatio = try c.decodeIfPresent(Double.self, forKey: .sampleRatio) ?? 1.0
        self.source = try c.decodeIfPresent([String: String].self, forKey: .source) ?? [:]
    }

    /// A normalised endpoint with any trailing slashes stripped, or `nil`
    /// when no endpoint is set or it's blank. swift-otel's OTLP/HTTP exporter
    /// appends `/v1/traces` / `/v1/logs`, so the base must not end in `/`.
    public var normalizedEndpoint: String? {
        guard let raw = endpoint?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        var trimmed = raw
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        return trimmed.isEmpty ? nil : trimmed
    }

    /// True when the server says telemetry is on AND a usable endpoint is
    /// present. The controller will only bootstrap swift-otel when this holds
    /// (and the user's local enable toggle is on).
    public var isExportable: Bool {
        enabled && normalizedEndpoint != nil
    }
}
