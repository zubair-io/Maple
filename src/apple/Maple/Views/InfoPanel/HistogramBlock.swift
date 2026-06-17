// HistogramBlock.swift — S6 Info content, section 2.
//
// Live RGB histogram on every platform (closes #633 / histogram-all-platforms).
// The view renders three overlaid line plots via `SwiftUI.Canvas` from a 3×256
// RGB histogram sourced, in priority order:
//
//   1. Self-Hosted — when a `\.cloudHistogramClient` is injected AND the bound
//      `AssetRef.stableID` is non-nil, fetch `GET /api/assets/:id/histogram`
//      (the server computes + caches it, so we don't download the full RAW).
//   2. Filesystem / PhotoKit — a local RAW computes on device via
//      `LocalHistogram` (the Rust core), debounced so a slider drag settles
//      before a decode. This is what makes the histogram work on Mac / iPad /
//      iPhone without a server.
//   3. Otherwise (non-RAW, or no source) — the decorative placeholder.
//
// Layout pact with the placeholder: same 56pt block height, 0.5pt border, 6pt
// corner radius, `surface` background. The live canvas fades in over the
// placeholder once the data lands, so the inspector never jumps; an in-place
// edit keeps the prior curves visible through the recompute (no mid-edit flash).

import MapleCore
import SwiftUI
import os

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
  /// The active editing session. The histogram is computed for `session.asset`
  /// under the live `session.model` / `session.culling`, so it tracks edits.
  /// `nil` ⇒ placeholder.
  let session: EditSession?

  @Environment(\.cloudHistogramClient) private var client
  @State private var histogram: CloudHistogram?
  @State private var loadFailed = false
  /// Identity of the asset the currently-shown `histogram` was computed for.
  /// Used to clear stale curves on an asset switch WITHOUT flashing the
  /// placeholder on every in-place edit (where only the model changes).
  @State private var shownAssetID: UUID?
  /// Generation counter so a late-arriving result for a superseded
  /// (asset, edit) tuple doesn't clobber the current one.
  @State private var loadGeneration: Int = 0

  private var asset: AssetRef? { session?.asset }

  private static let log = Logger(subsystem: "app.justmaple.aperture", category: "HistogramBlock")

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      sectionHeader("Histogram")
      block
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-panel-histogram")
    // Built here in `body` (MainActor) so reading the `@MainActor`
    // `EditSession`'s model/culling is legal; `.task` re-runs on any change.
    .task(
      id: TaskKey(
        assetID: asset?.id,
        stableID: asset?.stableID,
        clientHost: client?.server.absoluteString,
        model: session?.model,
        culling: session?.culling
      )
    ) {
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

  // MARK: - Fetch / compute

  /// Drive the histogram for the current (asset, edit, client) tuple. Called by
  /// `.task(id:)`, which cancels the inflight Task and re-runs whenever the
  /// tuple changes — so an asset swap or a settled edit supersedes the prior
  /// computation. The generation counter is defense-in-depth against
  /// out-of-order completions.
  ///
  /// Source priority:
  ///   1. **Self-Hosted** — a `CloudHistogramClient` is injected AND the asset
  ///      carries a server `stableID`: fetch `GET /api/assets/:id/histogram`.
  ///      The server computes + caches it, so we avoid downloading the full RAW
  ///      just to bin it locally.
  ///   2. **Filesystem / PhotoKit** — a local RAW (URL or bytes provider):
  ///      compute on device via `LocalHistogram` after a short debounce, so a
  ///      slider drag settles before we pay a decode.
  ///   3. Otherwise — non-RAW, or no source — the placeholder.
  @MainActor
  private func refresh() async {
    loadGeneration &+= 1
    let gen = loadGeneration

    // Clear stale curves only on an asset SWITCH. An in-place edit keeps the
    // last histogram visible through the recompute so the block never flashes
    // the placeholder mid-edit.
    if asset?.id != shownAssetID {
      histogram = nil
      loadFailed = false
    }

    guard let session, let asset else {
      loadFailed = true
      return
    }

    // 1. Self-Hosted server path.
    if let client, let assetID = asset.stableID {
      do {
        let result = try await client.histogram(assetID: assetID)
        guard gen == loadGeneration else { return }
        histogram = result
        loadFailed = false
        shownAssetID = asset.id
      } catch {
        guard gen == loadGeneration else { return }
        if histogram == nil { loadFailed = true }
      }
      return
    }

    // 2. Local on-device path (filesystem / PhotoKit). A RAW develops via the
    //    Rust FFI; a non-RAW asset (stitched panorama PNG, JPEG, HEIF) develops
    //    via the CoreImage non-RAW pipeline and bins the displayed pixels. Both
    //    are render-path-independent (they run their OWN develop rather than
    //    reading the live preview, so they survive the wgpu GPU live path, which
    //    emits no CIImage). Only a truly sourceless asset hits the placeholder.
    guard asset.primaryURL != nil || asset.bytesProvider != nil else {
      if histogram == nil { loadFailed = true }
      return
    }
    // Debounce: a slider drag re-keys `.task` on every tick, cancelling this
    // sleep, so the decode only fires ~after the edit settles.
    try? await Task.sleep(for: .milliseconds(350))
    if Task.isCancelled || gen != loadGeneration { return }

    // Snapshot the live edit on the main actor, then compute. `LocalHistogram`
    // is a `nonisolated async` namespace, so awaiting it directly hops OFF the
    // main actor for the decode + develop (the UI is never blocked) while
    // staying STRUCTURED under this `.task`: when the task re-keys on the next
    // edit, SwiftUI cancels this invocation before starting the new one, so
    // superseded computes don't run to completion or pile up (a detached task
    // would do neither — it ignores the parent's cancellation).
    let model = session.model
    let culling = session.culling
    do {
      // RAW develops via the Rust FFI; non-RAW (panorama PNG, JPEG, HEIF)
      // develops via the CoreImage non-RAW pipeline and bins the displayed
      // pixels. `culling` crop applies only to the RAW develop today.
      let result =
        asset.isRaw
        ? try await LocalHistogram.compute(asset: asset, model: model, culling: culling)
        : try await LocalHistogram.computeNonRaw(asset: asset, model: model)
      guard gen == loadGeneration else { return }
      histogram = result
      loadFailed = false
      shownAssetID = asset.id
    } catch {
      guard gen == loadGeneration else { return }
      if histogram == nil { loadFailed = true }
      Self.log.error(
        "local histogram compute failed (isRaw=\(asset.isRaw, privacy: .public), hasURL=\(asset.primaryURL != nil, privacy: .public), hasProvider=\(asset.bytesProvider != nil, privacy: .public)): \(String(describing: error), privacy: .public)"
      )
    }
  }

  /// Hashable composite key for `.task(id:)`. SwiftUI re-runs the task when
  /// this changes, giving per-(asset, edit, client) cancellation for free.
  /// Includes the model + culling so a settled edit recomputes the local
  /// histogram (and revalidates the Self-Hosted ETag). Plain memberwise init —
  /// the values are extracted in `body` (MainActor), where reading the
  /// `EditSession` is legal.
  private struct TaskKey: Hashable {
    let assetID: UUID?
    let stableID: String?
    let clientHost: String?
    let model: AdjustmentModel?
    let culling: CullingState?
  }
}

// MARK: - Previews

#Preview("HistogramBlock — placeholder") {
  // No session ⇒ no source ⇒ placeholder (the preview asset isn't on disk).
  HistogramBlock(session: nil)
    .frame(width: 280)
    .padding()
    .background(MapleTokens.bg)
}
