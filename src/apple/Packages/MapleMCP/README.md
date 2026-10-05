# MapleMCP

Maple on macOS serves MCP directly from the running app at **`http://127.0.0.1:49157/mcp`**. Enable **Settings → General → AI Agents**, choose **Copy setup prompt**, and paste it into your AI tool to configure the connection. Maple must stay open. No command-line build or separately installed server is needed.

The prompt includes the actual server URL, bearer credential, and concrete Codex and Cursor configurations that preserve other servers. For Claude Desktop it points to the bundled `Maple.mcpb` extension and explains how to install it; Claude supplies Node and the extension forwards stdio messages to the same app-owned URL. Claude's cloud-based custom connector cannot reach localhost.

The token is generated from secure random bytes and persists in the macOS Keychain. Treat the copied prompt as a credential. If another Maple server occupies the port, Settings reports the failure with a Retry action.

## Default photo export

`maple_export_photo` takes only `expected_revision` from the current photo state. It uses `MapleExporter` and `ExportOptions.defaults`: full-resolution JPEG sRGB at 92% quality, with the current edits and crop. Each call saves a uniquely named file in the app's Documents/Exports folder and returns its absolute path, filename, byte count, photo ID and exported revision. In sandboxed builds that folder is inside Maple's container. It needs no additional folder permissions or Save dialog. Existing files and originals are never replaced.

A missing/stale revision, busy session, photo change during rendering, or cancelled request fails without publishing an export. Encoding and file I/O run off the UI actor. The same tool is available through HTTP and the developer stdio bridge.

## Transport and editing contract

`MapleMCPHTTP` uses SwiftNIO for a stateless Streamable HTTP endpoint bound only to `127.0.0.1`. Every request requires a bearer token. Host and optional Origin must match the loopback endpoint, preventing browser-origin access and DNS rebinding. There is no CORS allowance, LAN listener, or remote relay. POST accepts JSON and advertises JSON plus SSE in Accept; replies use JSON, notifications receive 202, and GET receives 405 because this server has no server-initiated stream. It supports modern `2026-07-28` metadata headers and legacy `2025-11-25` / `2025-06-18` initialization. Requests are capped at 1 MiB, connections at 32, incomplete uploads at 10 seconds, and tool responses at 300 seconds to accommodate full-resolution RAW export.

HTTP calls await MapleCore's existing `AgentEditService` in process. Its tool catalog, live editor state, expected revisions, undo transactions, render inspection, and real XMP writes are shared with the existing socket bridge. Disabling agent access invalidates queued calls and closes the HTTP listener and clients. The HTTP service works independently of the App Group socket's availability.

The app has `com.apple.security.network.server` for sandboxed incoming connections. This is a macOS feature; iOS and tvOS do not link its HTTP product. Successful development builds do not qualify Mac App Store distribution: a signed distribution archive and App Review remain release gates.

## Existing developer stdio bridge

`MapleAgentWire` retains the same-user, mode-0600 Unix socket at `~/Library/Group Containers/group.app.justmaple.aperture/maple-agent.sock`. `MapleMCPServer` shares routing and serialization between HTTP and the `maple-mcp` developer executable. Existing qualification tooling can still run `swift build -c release --product maple-mcp` and connect over stdio. End users use the app's URL.

## Build and verify

```sh
swift test --package-path src/apple/Packages/MapleMCP
python3 src/apple/Packages/MapleMCP/package-claude-extension.py --check
```

Tests exercise real Unix sockets and HTTP listeners, authentication and origin checks, protocol negotiation, modern metadata, port conflicts, shutdown, and the actual Claude Node adapter against the same server. MapleCore's `AgentHTTPIntegrationTests` checks edits, stale revisions, undo, XMP persistence, and original-file preservation over HTTP.

The Claude extension source is `ClaudeDesktop/`; the app bundles `Sources/MapleMCPHTTP/Resources/Maple.mcpb`. After editing its manifest or adapter, run `python3 src/apple/Packages/MapleMCP/package-claude-extension.py`. CI verifies the bundled archive matches source. The extension contains no external dependencies or independent editing implementation.
