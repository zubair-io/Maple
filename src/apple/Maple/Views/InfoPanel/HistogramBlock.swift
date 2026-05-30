// HistogramBlock.swift — S6 Info content, section 2.
//
// Live RGB histogram for Self-Hosted assets (closes #633). The view
// reaches for the optional `\.cloudHistogramClient` SwiftUI environment
// value and, when set and the bound `AssetRef.stableID` is non-nil,
// fetches `GET /api/assets/:id/histogram` and renders three overlaid
// line plots via `SwiftUI.Canvas`. Local-only assets (filesystem /
// PhotoKit) get the original decorative placeholder — the asset id on
// the server is only minted for cloud-shaped rows.
//
// Layout pact with the placeholder: same 56pt block height, 0.5pt
// border, 6pt corner radius, `surface` background. The live canvas
// fades in over the placeholder once the fetch completes, so the
// inspector never jumps.

import MapleCore
import SwiftUI

// MARK: - Environment key

/// Environment slot for the Self-Hosted histogram client. `nil` (the
/// default) means "no server in this context" — the HistogramBlock
/// shows the placeholder. The Cloud action setup injects a concrete
/// client when the user opens a Self-Hosted library, mirroring the
/// existing `CloudThumbClient` plumbing.
struct CloudHistogramClientKey: EnvironmentKey {
  static let defaultValue: CloudHistogramClient? = nil
}

extension EnvironmentValues {
  var cloudHistogramClient: CloudHistogramClient? {
    get { self[CloudHistogramClientKey.self] }
    set { self[CloudHistogramClientKey.self] = newValue }
  }
}

// MARK: - HistogramBlock

struct HistogramBlock: View {
  let asset: AssetRef?

  @Environment(\.cloudHistogramClient) private var client
  @State private var histogram: CloudHistogram?
  @State private var loadFailed = false
  /// Generation counter so a late-arriving fetch result for a previous
  /// asset doesn't clobber the current one. Bumped on every asset change.
  @State private var loadGeneration: Int = 0

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      sectionHeader("Histogram")
      block
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-panel-histogram")
    .task(id: TaskKey(client: client, assetID: asset?.stableID)) {
      await refresh()
    }
  }

  // MARK: - Block body — live or placeholder

  @ViewBuilder
  private var block: some View {
    if let histogram, !loadFailed {
      liveBlock(histogram)
    } else {
      placeholder
    }
  }

  private func liveBlock(_ data: CloudHistogram) -> some View {
    RoundedRectangle(cornerRadius: 6)
      .fill(MapleTokens.surface)
      .frame(height: 56)
      .overlay(
        RoundedRectangle(cornerRadius: 6)
          .stroke(MapleTokens.border, lineWidth: 0.5)
      )
      .overlay(
        Canvas { context, size in
          // Three overlaid line plots — one per channel — normalised by
          // the channel's own max so a single hot bin doesn't flatten
          // the rest of the curve.
          drawChannel(context, size: size, bins: data.r, color: .red)
          drawChannel(context, size: size, bins: data.g, color: .green)
          drawChannel(context, size: size, bins: data.b, color: .blue)
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .accessibilityLabel("RGB histogram")
      )
  }

  private func drawChannel(
    _ context: GraphicsContext,
    size: CGSize,
    bins: [Int],
    color: Color
  ) {
    let maxVal = max(1, bins.max() ?? 1)  // ≥1 so a flat-zero channel renders as the baseline
    var path = Path()
    let stepX = size.width / CGFloat(max(1, bins.count - 1))
    for (i, v) in bins.enumerated() {
      let x = CGFloat(i) * stepX
      let y = size.height - (CGFloat(v) / CGFloat(maxVal)) * size.height
      if i == 0 {
        path.move(to: CGPoint(x: x, y: y))
      } else {
        path.addLine(to: CGPoint(x: x, y: y))
      }
    }
    context.stroke(
      path,
      with: .color(color.opacity(0.7)),
      lineWidth: 1
    )
  }

  // MARK: - Placeholder (no client, no stableID, fetch error)

  private var placeholder: some View {
    ZStack {
      // Three faint gradient bands telegraph "this will be RGB curves
      // soon" without claiming to be data. Avoids the user mistaking
      // a flat gray rect for an actually-flat histogram.
      RoundedRectangle(cornerRadius: 6)
        .fill(MapleTokens.surface)
        .frame(height: 56)
        .overlay(
          RoundedRectangle(cornerRadius: 6)
            .stroke(MapleTokens.border, lineWidth: 0.5)
        )
        .overlay(
          GeometryReader { geo in
            ZStack {
              histogramCurve(color: .red, amplitude: 0.6, phase: 0.0, in: geo.size)
              histogramCurve(color: .green, amplitude: 0.7, phase: 0.4, in: geo.size)
              histogramCurve(color: .blue, amplitude: 0.5, phase: 0.8, in: geo.size)
            }
            .opacity(0.25)
          }
          .clipShape(RoundedRectangle(cornerRadius: 6))
        )
      Text("Histogram")
        .font(MapleTokens.Typography.eyebrow)
        .tracking(1.0)
        .foregroundStyle(MapleTokens.textMuted)
    }
    .accessibilityLabel("Histogram preview unavailable")
  }

  /// Synthetic Gaussian-ish bump for the placeholder. NOT real data;
  /// purely decorative so the placeholder reads as a histogram-shaped
  /// region instead of an empty box.
  private func histogramCurve(
    color: Color,
    amplitude: Double,
    phase: Double,
    in size: CGSize
  ) -> some View {
    Path { path in
      let w = size.width
      let h = size.height
      let center = w * phase
      let sigma = w * 0.20
      path.move(to: CGPoint(x: 0, y: h))
      for x in stride(from: 0.0, through: w, by: 2.0) {
        let dx = (x - center) / sigma
        let y = h - h * amplitude * exp(-0.5 * dx * dx)
        path.addLine(to: CGPoint(x: x, y: y))
      }
      path.addLine(to: CGPoint(x: w, y: h))
      path.closeSubpath()
    }
    .fill(color)
  }

  private func sectionHeader(_ title: String) -> some View {
    Text(title.uppercased())
      .font(MapleTokens.Typography.eyebrow)
      .foregroundStyle(MapleTokens.textMuted)
      .tracking(1.4)
  }

  // MARK: - Fetch

  /// Drive the fetch for the current (client, asset) tuple. Called by
  /// `.task(id:)`, which automatically cancels the inflight Task and
  /// re-runs whenever the tuple changes — so an asset swap mid-fetch
  /// drops the stale result. The generation counter is a defense in
  /// depth for the rare case where two adjacent fetches differ only in
  /// the order of their completions.
  private func refresh() async {
    loadGeneration &+= 1
    let gen = loadGeneration
    // Reset state when the underlying tuple changes so the previous
    // asset's histogram doesn't flash on the new asset.
    histogram = nil
    loadFailed = false

    guard let client, let assetID = asset?.stableID else {
      // No server context or no cross-session id — placeholder only.
      return
    }
    do {
      let result = try await client.histogram(assetID: assetID)
      // Late-result guard.
      guard gen == loadGeneration else { return }
      histogram = result
    } catch {
      guard gen == loadGeneration else { return }
      loadFailed = true
    }
  }

  /// Hashable composite key for `.task(id:)`. SwiftUI re-runs the task
  /// when this changes, which gives us automatic per-(client, asset)
  /// cancellation without writing our own lifecycle code.
  private struct TaskKey: Hashable {
    /// Identifies the client by its server URL — actors are not
    /// Hashable, but the (server, assetID) pair is the load-bearing
    /// identity for cache purposes anyway.
    let serverHost: String?
    let assetID: String?

    init(client: CloudHistogramClient?, assetID: String?) {
      self.serverHost = client?.server.absoluteString
      self.assetID = assetID
    }
  }
}

// MARK: - Previews

#Preview("HistogramBlock — placeholder") {
  HistogramBlock(asset: .preview())
    .frame(width: 280)
    .padding()
    .background(MapleTokens.bg)
}
