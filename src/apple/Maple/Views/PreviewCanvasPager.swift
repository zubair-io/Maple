// PreviewCanvasPager.swift — Preview's photo area (#5762).
//
// The visible page owns the shared canvas (`PreviewCanvasPage`); on touch
// screens its neighbours sit beside it as plain stills. A drag goes where
// Photos sends it: at fit, down pulls Preview closed and sideways turns the
// page; zoomed in, it pans, and once the photo's edge reaches the screen's
// the rest of the same drag moves the page. A turned page keeps its still, so
// the photo that slides in never reloads. macOS pages with the arrow keys and
// shows the visible page alone. Edit hands the editor the zoom and the still
// on screen, and coming back picks up where the editor left it (#5764).

import MapleCore
import SwiftUI

struct PreviewCanvasPager: View {
  let asset: AssetRef
  let assets: [AssetRef]
  let source: (any ImageSource)?
  let provider: ThumbnailProvider
  /// The visible photo's session, once primed; it owns the canvas.
  let session: EditSession?
  /// Where Edit finds the canvas on screen to hand to the editor.
  let onScreen: PreviewCanvasOnScreen
  let onSelectAsset: (AssetRef) -> Void
  var onPlainPullChanged: (CGSize) -> Void = { _ in }
  var onPlainPullEnded: (CGSize, CGSize, CGRect?) -> Void = { _, _, _ in }

  @Environment(\.previewCanvasIsCovered) private var isCovered
  @State private var isOnScreen = true
  @State private var stills = PreviewStillStore()
  @State private var zoom: CanvasZoomController?
  @State private var pageOffset: CGFloat = 0
  @State private var route = PreviewDragRoute()
  @State private var isTurning = false
  /// With two photos, the side the other one sits on: set by the live drag
  /// only, so a spring back never swaps it across the screen.
  @State private var otherPhotoSide = 1
  private static let pageGap: CGFloat = 20

  var body: some View {
    GeometryReader { geometry in
      let stride = geometry.size.width + Self.pageGap
      ZStack {
        ForEach(window) { page in
          let loader = stills.loader(for: page.asset, source: source, provider: provider)
          PreviewCanvasPage(
            loader: loader,
            zoom: page.position == 0 ? currentZoom : nil,
            isVisible: page.position == 0,
            paging: page.position == 0 ? paging(pageWidth: stride) : nil
          )
          .id(ObjectIdentifier(loader))
          .offset(x: CGFloat(page.position) * stride + pageOffset)
        }
      }
      .frame(width: geometry.size.width, height: geometry.size.height)
      .clipped()
      .allowsHitTesting(!isTurning)
    }
    // An editor pushed over Preview (a navigation push hides it; the
    // iPhone hero only fades it) drives the photo's session from then on.
    .environment(\.previewCanvasIsCovered, isCovered || !isOnScreen)
    .onAppear { isOnScreen = true }
    .onDisappear { isOnScreen = false }
    .onChange(of: SessionKey(asset: asset.id, session: session), initial: true) {
      adoptSession()
    }
    .onChange(of: isCovered || !isOnScreen) { _, covered in
      guard !covered, let zoom = currentZoom else { return }
      receiveHandoff(into: zoom)
    }
    .onChange(of: OnScreenKey(zoom: currentZoom, loader: visibleLoader), initial: true) {
      onScreen.zoom = currentZoom
      onScreen.loader = visibleLoader
    }
    .onChange(of: window.map(\.asset.id)) { _, ids in
      stills.keep(Set(ids))
    }
  }

  /// The controller of the visible photo's own session; never a previous
  /// photo's while the next one's session is being primed.
  private var currentZoom: CanvasZoomController? {
    zoom.flatMap { $0.session.asset.id == asset.id ? $0 : nil }
  }

  /// The visible page's loader: a source arriving late replaces it (#3551).
  private var visibleLoader: PreviewStillLoader {
    stills.loader(for: asset, source: source, provider: provider)
  }

  private struct OnScreenKey: Equatable {
    let zoom: ObjectIdentifier?
    let loader: ObjectIdentifier

    init(zoom: CanvasZoomController?, loader: PreviewStillLoader) {
      self.zoom = zoom.map(ObjectIdentifier.init)
      self.loader = ObjectIdentifier(loader)
    }
  }

  private struct SessionKey: Equatable {
    let asset: AssetRef.ID
    let session: ObjectIdentifier?

    init(asset: AssetRef.ID, session: EditSession?) {
      self.asset = asset
      self.session = session.map(ObjectIdentifier.init)
    }
  }

  /// A new photo gets a canvas that renders nothing until zoomed past its
  /// still. The photo paged away from frees its decode, which the editor may
  /// have left behind even if this Preview never rendered it.
  private func adoptSession() {
    let adopted = session.flatMap { $0.asset.id == asset.id ? $0 : nil }
    guard zoom?.session !== adopted else { return }
    if let previous = zoom, previous.rendersSession || previous.session.asset.id != asset.id {
      previous.stopRenderingSession()
      Task { await previous.session.releaseTransientMemory() }
    }
    zoom = adopted.map { CanvasZoomController(session: $0, rendersSession: false) }
    if let zoom { receiveHandoff(into: zoom) }
  }

  /// The editor closed over this photo: show it as the editor left it.
  private func receiveHandoff(into zoom: CanvasZoomController) {
    guard let handoff = zoom.session.takeCanvasHandoff() else { return }
    zoom.receive(handoff)
    if let still = handoff.still {
      visibleLoader.showHandedOff(still)
    }
  }

  // MARK: - Pages

  private struct Page: Identifiable {
    let asset: AssetRef
    let position: Int
    var id: AssetRef.ID { asset.id }
  }

  /// The visible page and, on touch screens, its wrapped neighbours. With
  /// two photos the other one sits on whichever side the drag reveals.
  private var window: [Page] {
    let current = Page(asset: asset, position: 0)
    #if os(iOS)
      guard assets.count > 1, let index = assets.firstIndex(where: { $0.id == asset.id }) else {
        return [current]
      }
      let previous = assets[(index - 1 + assets.count) % assets.count]
      let next = assets[(index + 1) % assets.count]
      guard previous.id != next.id else {
        return [current, Page(asset: next, position: otherPhotoSide)]
      }
      return [Page(asset: previous, position: -1), current, Page(asset: next, position: 1)]
    #else
      return [current]
    #endif
  }

  private func neighbour(_ turn: PreviewPageTurn) -> AssetRef? {
    window.first { $0.position == turn.rawValue }?.asset
  }

  // MARK: - Drags

  private func paging(pageWidth: CGFloat) -> CanvasPagingHooks? {
    #if os(iOS)
      CanvasPagingHooks(
        changed: { dragChanged($0) },
        ended: { dragEnded($0, pageWidth: pageWidth) },
        cancelled: { dragCancelled() })
    #else
      nil
    #endif
  }

  private func dragChanged(_ frame: CanvasPagingHooks.Frame) {
    guard !isTurning else { return }
    let pullAllowed = !frame.isZoomedIn && !frame.isPinching
    switch route.classify(translation: frame.translation, pullAllowed: pullAllowed) {
    case .pull: onPlainPullChanged(frame.translation)
    case .page:
      pageOffset = assets.count > 1 ? frame.unabsorbed : 0
      if pageOffset != 0 { otherPhotoSide = pageOffset > 0 ? -1 : 1 }
    case .undecided: break
    }
  }

  private func dragEnded(_ release: CanvasPagingHooks.Release, pageWidth: CGFloat) {
    let decided = route.kind
    route = PreviewDragRoute()
    guard !isTurning else { return }
    switch decided {
    case .pull:
      onPlainPullEnded(release.frame.translation, release.velocity, release.shownRect)
    case .page, .undecided:
      let turn = PreviewPageTurn.decide(
        offset: pageOffset, predictedOffset: release.predictedUnabsorbed, pageWidth: pageWidth,
        canTurn: assets.count > 1)
      settle(turn, pageWidth: pageWidth)
    }
  }

  private func dragCancelled() {
    let decided = route.kind
    route = PreviewDragRoute()
    if decided == .pull { onPlainPullEnded(.zero, .zero, nil) }
    guard !isTurning else { return }
    settle(.stay, pageWidth: 0)
  }

  /// Slide to the turned page, then make it the visible one in the same
  /// update that puts the pager back at rest, so nothing jumps.
  private func settle(_ turn: PreviewPageTurn, pageWidth: CGFloat) {
    guard turn != .stay, let target = neighbour(turn) else {
      withAnimation(.spring(response: 0.3, dampingFraction: 0.9)) { pageOffset = 0 }
      return
    }
    isTurning = true
    withAnimation(.spring(response: 0.3, dampingFraction: 0.95)) {
      pageOffset = -CGFloat(turn.rawValue) * pageWidth
    } completion: {
      var instant = Transaction()
      instant.disablesAnimations = true
      withTransaction(instant) {
        pageOffset = 0
        isTurning = false
        onSelectAsset(target)
      }
    }
  }
}

/// The stills of the pages on screen, kept across a page turn so the photo
/// that slides in keeps what it was showing as a neighbour.
@MainActor
@Observable
final class PreviewStillStore {
  private struct Entry {
    let loader: PreviewStillLoader
    let source: ObjectIdentifier?
  }

  /// Created while the pager's body is evaluated, so never observed.
  @ObservationIgnored private var loaders: [AssetRef.ID: Entry] = [:]

  /// A source that arrives after the page was built (the Search tab sets it
  /// in the same tap that pushes Preview) gets a new loader, or the page
  /// would stay on the sourceless path with no display tier (#3551).
  func loader(
    for asset: AssetRef, source: (any ImageSource)?, provider: ThumbnailProvider
  ) -> PreviewStillLoader {
    let sourceID = (source as AnyObject?).map(ObjectIdentifier.init)
    if let existing = loaders[asset.id], existing.loader.asset == asset,
      existing.source == sourceID
    {
      return existing.loader
    }
    let made = PreviewStillLoader(asset: asset, source: source, provider: provider)
    loaders[asset.id] = Entry(loader: made, source: sourceID)
    return made
  }

  func keep(_ ids: Set<AssetRef.ID>) {
    loaders = loaders.filter { ids.contains($0.key) }
  }
}

/// The visible page's canvas and still, which Edit hands to the editor.
@MainActor
final class PreviewCanvasOnScreen {
  weak var zoom: CanvasZoomController?
  weak var loader: PreviewStillLoader?

  /// Replaces whatever `session` held, so the editor never opens with an
  /// older photo's leftovers.
  func handOff(to session: EditSession?) {
    let shown = zoom.flatMap { $0.session === session ? $0 : nil }
    session?.canvasHandoff = shown?.handoff(still: loader?.handoffStill)
  }
}
