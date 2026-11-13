// PreviewCanvasPaging.swift — how a drag on Preview's shared canvas is split
// between dismissing, panning and turning the page, and when the page starts
// rendering the RAW (#5762).
//
// Like Photos: at fit a sideways swipe turns the page and a downward pull
// dismisses. Zoomed in, a drag pans the photo; once its edge reaches the
// screen's, the rest of the same drag moves the page
// (`CanvasZoomController.unabsorbedHorizontalDrag`).

import CoreGraphics
import Foundation

/// What one touch on a Preview page does, decided once and kept until it ends,
/// so a pull never turns into a page swipe halfway through.
public struct PreviewDragRoute: Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case undecided
    case pull
    case page
  }

  /// Travel before a touch at fit is read as a pull or a page swipe. Long
  /// enough to read a direction from a real finger, whose first points wobble
  /// sideways; short enough that paging never feels delayed.
  public static let decisionDistance: CGFloat = 14

  public private(set) var kind: Kind = .undecided

  public init() {}

  /// A pull only has to be downward and at least as vertical as it is
  /// horizontal (Photos' rule; anything stricter drops real pulls).
  public static func beginsPull(translation: CGSize) -> Bool {
    translation.height > 0 && translation.height >= abs(translation.width)
  }

  /// Classify the touch from its running translation. `pullAllowed` is false
  /// while the photo is zoomed in, when a vertical drag is the photo's pan, so
  /// the touch belongs to paging (and the pan) from its first point.
  @discardableResult
  public mutating func classify(translation: CGSize, pullAllowed: Bool) -> Kind {
    guard kind == .undecided else { return kind }
    guard pullAllowed else {
      kind = .page
      return kind
    }
    guard hypot(translation.width, translation.height) >= Self.decisionDistance else {
      return kind
    }
    kind = Self.beginsPull(translation: translation) ? .pull : .page
    return kind
  }
}

/// Where a released page swipe goes.
public enum PreviewPageTurn: Int, Equatable, Sendable {
  case previous = -1
  case stay = 0
  case next = 1

  /// Past half the page, or flicked past it, turns; anything less springs
  /// back. A drag to the left (negative offset) shows the next photo.
  /// `predictedOffset` is where the flick would carry the page.
  public static func decide(
    offset: CGFloat, predictedOffset: CGFloat, pageWidth: CGFloat, canTurn: Bool
  ) -> PreviewPageTurn {
    guard canTurn, pageWidth > 0 else { return .stay }
    let threshold = pageWidth / 2
    let flicked =
      abs(offset) >= minimumFlickTravel && abs(predictedOffset) >= threshold
      && (predictedOffset < 0) == (offset < 0)
    guard abs(offset) >= threshold || flicked else { return .stay }
    return offset < 0 ? .next : .previous
  }

  /// A tap's jitter is not a flick, however fast.
  static let minimumFlickTravel: CGFloat = 8
}

/// When Preview stops showing its stills and renders the RAW.
public enum PreviewCanvasRender {
  /// Only once the photo is zoomed in past the still's own resolution: at fit
  /// (even where a large screen shows more pixels than the still has) and at
  /// any zoom the still can supply, the still is all Preview shows, so opening
  /// and paging never decode.
  public static func shouldRender(
    isZoomedIn: Bool, shownLongEdgePixels: CGFloat, stillLongEdgePixels: CGFloat
  ) -> Bool {
    isZoomedIn && stillLongEdgePixels > 0 && shownLongEdgePixels > stillLongEdgePixels
  }

  /// What covers the still. A frame of the render covers it only once it has
  /// at least as many pixels, so zooming never swaps in a softer source
  /// (#5768): not the grid thumbnail or embedded JPEG the session seeds itself
  /// with, nor a viewport-sized fast pass. The GPU frame also waits out the
  /// full-quality decode, before which it develops a seed.
  public static func cover(
    usesGpu: Bool, gpuFramePresented: Bool, gpuFrameLongEdgePixels: CGFloat,
    isFullQualityDecoding: Bool, cpuFrameLongEdgePixels: CGFloat, stillLongEdgePixels: CGFloat
  ) -> PreviewCanvasCover {
    let gpuCovers =
      usesGpu && gpuFramePresented && !isFullQualityDecoding
      && isAtLeastAsSharp(gpuFrameLongEdgePixels, as: stillLongEdgePixels)
    let cpuCovers = isAtLeastAsSharp(cpuFrameLongEdgePixels, as: stillLongEdgePixels)
    return gpuCovers ? .gpuFrame : cpuCovers ? .cpuFrame : .still
  }

  private static func isAtLeastAsSharp(_ frameLongEdgePixels: CGFloat, as still: CGFloat) -> Bool {
    frameLongEdgePixels > 0 && frameLongEdgePixels >= still
  }
}

/// What a rendering Preview page shows on top.
public enum PreviewCanvasCover {
  case still
  case gpuFrame
  case cpuFrame
}
