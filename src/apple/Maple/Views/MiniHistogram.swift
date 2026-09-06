// MiniHistogram.swift — the shared live RGB histogram (curves + data loading).
//
// One implementation, two sizes: the 56pt S6 Info block (`HistogramBlock`) and
// the 70×30 chip in the canvas-first editor pill (`PillHeader`, #1583). Both
// need identical curves off identical data, so the `SwiftUI.Canvas` drawing and
// the source-priority loader live here rather than being copied per surface.
//
// This view draws ONLY the curves. Chrome — fill, border, corner radius — and
// the size are applied by the caller, so each surface keeps its own token set
// (`MapleTokens` in the inspector, `ProTokens` in the editor) without this view
// growing a theming knob. What to show before data lands is likewise the
// caller's call, supplied as the `placeholder` slot: the inspector block has
// room for decorative bands plus a label, the 30pt chip stays empty rather than
// drawing curve-shaped art that would read as real data at that size.
//
// The current canvas preview supplies the live histogram, shared between both
// views by EditSession. A server histogram is only an initial fallback before
// the first canvas frame. Editor updates never decode the RAW again.
//
// The compute is deliberately off the render path: it is keyed on the settled
// edit and debounced 350ms, so a slider drag re-keys (and cancels) rather than
// recomputing per tick. An in-place edit keeps the prior curves on screen
// through the recompute, so neither surface flashes mid-edit.

import MapleCore
import OSLog
import SwiftUI

// MARK: - Environment key

/// Environment slot for the Self-Hosted histogram client. `nil` (the
/// default) means "no server in this context" — the histogram falls back
/// to the on-device compute, and then to the caller's placeholder. The
/// Cloud action setup injects a concrete client when the user opens a
/// Self-Hosted library, mirroring the existing `CloudThumbClient` plumbing.
struct CloudHistogramClientKey: EnvironmentKey {
  static let defaultValue: CloudHistogramClient? = nil
}

extension EnvironmentValues {
  var cloudHistogramClient: CloudHistogramClient? {
    get { self[CloudHistogramClientKey.self] }
    set { self[CloudHistogramClientKey.self] = newValue }
  }
}

private let miniHistogramLog = Logger(
  subsystem: "app.justmaple.aperture",
  category: "MiniHistogram"
)

// MARK: - MiniHistogram

struct MiniHistogram<Placeholder: View>: View {
  /// The active editing session. The histogram is computed for `session.asset`
  /// under the live `session.model` / `session.culling`, so it tracks edits.
  /// `nil` ⇒ placeholder.
  let session: EditSession?
  /// Shown until (and instead of) live curves. See the file note.
  @ViewBuilder let placeholder: () -> Placeholder

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

  /// The histogram to draw, or `nil` when the caller's placeholder should show.
  private var live: CloudHistogram? { loadFailed ? nil : histogram }

  var body: some View {
    ZStack {
      // Claims the proposed size unconditionally, so the caller's chrome still
      // lays out at the intended size while the placeholder is empty — an
      // `EmptyView` placeholder contributes no layout of its own.
      Color.clear
      content
    }
    // A leaf element: the curves carry no per-child semantics, and the
    // placeholder's decorative art is not information.
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(live == nil ? "Histogram preview unavailable" : "RGB histogram")
    // Built here in `body` (MainActor) so reading the `@MainActor`
    // `EditSession`'s model/culling is legal; `.task` re-runs on any change.
    .task(
      id: TaskKey(
        assetID: asset?.id,
        stableID: asset?.stableID,
        clientHost: client?.server.absoluteString,
        model: session?.model,
        culling: session?.culling,
        renderRevision: session?.histogramState.revision ?? 0
      )
    ) {
      await refresh()
    }
  }

  @ViewBuilder
  private var content: some View {
    if let data = live {
      Canvas { context, size in
        // Three overlaid line plots — one per channel — normalised by
        // the channel's own max so a single hot bin doesn't flatten
        // the rest of the curve.
        drawChannel(context, size: size, bins: data.r, color: .red)
        drawChannel(context, size: size, bins: data.g, color: .green)
        drawChannel(context, size: size, bins: data.b, color: .blue)
      }
    } else {
      placeholder()
    }
  }

  private func drawChannel(
    _ context: GraphicsContext,
    size: CGSize,
    bins: [Int],
    color: Color
  ) {
    let maxVal = max(1, bins.max() ?? 1)  // ≥1 so a flat-zero channel renders as the baseline
    let stepX = size.width / CGFloat(max(1, bins.count - 1))
    let points = bins.enumerated().map { i, v in
      CGPoint(
        x: CGFloat(i) * stepX,
        y: size.height - (CGFloat(v) / CGFloat(maxVal)) * size.height
      )
    }
    guard let first = points.first else { return }
    var path = Path()
    path.move(to: first)
    path.addLines(Array(points.dropFirst()))
    context.stroke(
      path,
      with: .color(color.opacity(0.7)),
      lineWidth: 1
    )
  }

  // MARK: - Fetch / compute

  /// Debounce outside the canvas render path. Presented-frame revision also
  /// rekeys this task after initial decode, refine, and crop-tool transitions.
  @MainActor
  private func refresh() async {
    loadGeneration &+= 1
    let gen = loadGeneration

    // Clear stale curves only on an asset SWITCH. An in-place edit keeps the
    // last histogram visible through the recompute so neither surface flashes
    // the placeholder mid-edit.
    if asset?.id != shownAssetID {
      histogram = nil
      loadFailed = false
    }

    guard let session, let asset else {
      loadFailed = true
      return
    }

    do {
      try await Task.sleep(for: .milliseconds(350))
      let result = try await session.histogramForCurrentPreview()
      try Task.checkCancellation()
      guard gen == loadGeneration else { return }
      if let result {
        histogram = result
        loadFailed = false
        shownAssetID = asset.id
      } else if session.histogramState.revision == 0, let client, let assetID = asset.stableID {
        let initial = try await client.histogram(assetID: assetID)
        try Task.checkCancellation()
        guard gen == loadGeneration else { return }
        histogram = initial
        loadFailed = false
        shownAssetID = asset.id
      }
    } catch is CancellationError {
      return
    } catch {
      guard gen == loadGeneration else { return }
      if histogram == nil { loadFailed = true }
      miniHistogramLog.error(
        "preview histogram failed: \(String(describing: error), privacy: .public)")
    }
  }

  /// Hashable composite key for `.task(id:)`. SwiftUI re-runs the task when
  /// this changes, giving per-(asset, edit, client) cancellation for free.
  /// Includes the presented-frame revision for decode/refine/crop transitions
  /// and the model/culling to cancel a superseded view request. Plain memberwise init —
  /// the values are extracted in `body` (MainActor), where reading the
  /// `EditSession` is legal.
  private struct TaskKey: Hashable {
    let assetID: UUID?
    let stableID: String?
    let clientHost: String?
    let model: AdjustmentModel?
    let culling: CullingState?
    let renderRevision: UInt64
  }
}

extension MiniHistogram where Placeholder == EmptyView {
  /// Curves-or-nothing. Used by the editor pill chip, which is too small to
  /// carry placeholder art that wouldn't be mistaken for data.
  init(session: EditSession?) {
    self.init(session: session) { EmptyView() }
  }
}
