// ObservabilityConfig.swift
//
// DTO for `GET /api/observability/config` — the resolved SigNoz /
// OpenTelemetry runtime config the self-hosted server hands to authenticated
// clients so the native app can ship telemetry direct-to-SigNoz over
// OTLP/HTTP.
//
// Wire shape (snake_case on the wire; mapped via CodingKeys):
//
//   {
//     "enabled": true,
//     "endpoint": "https://signoz.example.com:4318",   // may be null
//     "ingestion_key": "…",                            // may be null — secret
//     "service_namespace": "maple",
//     "traces_enabled": true,
//     "logs_enabled": true,
//     "metrics_enabled": false,
//     "sample_ratio": 1.0,
//     "source": { "endpoint": "db|env|unset", "...": "..." }
//   }
//
// `endpoint` / `ingestion_key` may be null when the operator hasn't configured
// a SigNoz target yet — in that case telemetry is a no-op. The exporter appends
// `/v1/traces` and `/v1/logs` to `endpoint`, so the base must NOT carry a
// trailing slash (the server normalises this; we trim defensively in the
// controller before handing the value to swift-otel).
//
// The `source` map is diagnostic provenance ("which layer supplied each
// field": db override, env fallback, or unset). It's decoded loosely as
// `[String: String]` because its keys are open-ended and the native side only
// surfaces it for display, never branches on it.

import Foundation

public struct ObservabilityConfig: Codable, Equatable, Sendable {

    /// Master switch. When false the server is telling us to ship nothing.
    public var enabled: Bool

    /// OTLP/HTTP base URL (no trailing slash). `nil` → telemetry is a no-op.
    public var endpoint: String?

    /// SigNoz ingestion key. Secret — sent as the `signoz-access-token`
    /// header. `nil` when the server hasn't configured one. Never logged.
    public var ingestionKey: String?

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
        ingestionKey: String?,
        serviceNamespace: String,
        tracesEnabled: Bool,
        logsEnabled: Bool,
        metricsEnabled: Bool,
        sampleRatio: Double,
        source: [String: String] = [:]
    ) {
        self.enabled = enabled
        self.endpoint = endpoint
        self.ingestionKey = ingestionKey
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
        case ingestionKey = "ingestion_key"
        case serviceNamespace = "service_namespace"
        case tracesEnabled = "traces_enabled"
        case logsEnabled = "logs_enabled"
        case metricsEnabled = "metrics_enabled"
        case sampleRatio = "sample_ratio"
        case source
    }

    // Defensive decode: the server always sends the resolved shape with all
    // keys present, but tolerate a sparse/forward-compatible payload (an
    // older or partial server) by defaulting any missing field. `endpoint`
    // and `ingestion_key` are explicitly nullable on the wire.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        self.endpoint = try c.decodeIfPresent(String.self, forKey: .endpoint)
        self.ingestionKey = try c.decodeIfPresent(String.self, forKey: .ingestionKey)
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
