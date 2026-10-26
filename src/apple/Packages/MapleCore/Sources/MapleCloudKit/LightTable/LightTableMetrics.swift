// LightTableMetrics.swift
//
// Stage geometry and type sizes for the Light Table (#2121 F2, #5457). Maple
// TV renders onto a fixed 1920×1080 canvas and keeps its original hand-tuned
// values (`television`); iPhone and iPad derive theirs from the container
// (`fitting(_:)`), recomputed on rotation.
//
// The stage is a coarse grid of slots, and a print settles into one of them,
// jittered so the grid never reads as a grid. Purely random positions let
// prints pile on top of each other; choosing an unoccupied slot spreads them
// over the whole table instead. Slot positions are expressed in normalised
// stage coordinates (-1...1 on each axis), and `offset(for:)` clamps them to
// the current grid's reach, so a print laid out before a rotation still lands
// inside the rotated stage.

import CoreGraphics

public struct LightTableMetrics: Equatable, Sendable {
  public let columns: Int
  public let rows: Int
  /// Half-extent of the area slot centres are spread across, inset so a
  /// print in an edge slot (plus its tilt and shadow) is never clipped.
  public let stageHalfWidth: CGFloat
  public let stageHalfHeight: CGFloat
  /// How far a print may sit from its slot centre — well under the slot
  /// pitch, so neighbours overlap a little without collapsing together.
  public let slotJitter: CGFloat
  public let imageSize: CGFloat
  public let matPadding: CGFloat
  /// Horizontal distance a print glides in from, and slides off by.
  public let entryOffset: CGFloat
  public let exitOffset: CGFloat
  public let iconSize: CGFloat
  public let titleSize: CGFloat
  public let bodySize: CGFloat
  public let captionSize: CGFloat
  public let messageWidth: CGFloat

  public var slotCount: Int { columns * rows }

  /// The furthest a settled print is tilted either way, in degrees.
  public static let maxTilt: Double = 8

  /// Half-width of the axis-aligned box around a square print of `span`
  /// points tilted by `maxTilt` about its own centre.
  public static func tiltedHalfExtent(ofSpan span: CGFloat) -> CGFloat {
    let radians = maxTilt * .pi / 180
    return span / 2 * CGFloat(abs(cos(radians)) + abs(sin(radians)))
  }

  public static let television = LightTableMetrics(
    columns: 4, rows: 3,
    stageHalfWidth: 660, stageHalfHeight: 340,
    slotJitter: 60, imageSize: 300, matPadding: 16,
    entryOffset: 1100, exitOffset: 2200,
    iconSize: 56, titleSize: 28, bodySize: 20, captionSize: 18, messageWidth: 560)

  /// Metrics for a phone or tablet stage of `size` points. The print size
  /// follows the short side, so a rotation reflows the slot grid without
  /// resizing the prints already on the table.
  public static func fitting(_ size: CGSize) -> LightTableMetrics {
    let imageSize = min(300, max(96, (min(size.width, size.height) * 0.26).rounded()))
    let matPadding = max(6, (imageSize * 16 / 300).rounded())
    let printSpan = imageSize + matPadding * 2
    let slotPitch = printSpan * 1.15
    let columns = min(5, max(2, Int(size.width / slotPitch)))
    let rows = min(5, max(2, Int(size.height / slotPitch)))
    let jitter = (imageSize * 0.2).rounded()
    let edgeClearance = tiltedHalfExtent(ofSpan: printSpan) + jitter + matPadding
    return LightTableMetrics(
      columns: columns, rows: rows,
      stageHalfWidth: halfExtent(size.width / 2 - edgeClearance, bands: columns),
      stageHalfHeight: halfExtent(size.height / 2 - edgeClearance, bands: rows),
      slotJitter: jitter, imageSize: imageSize, matPadding: matPadding,
      entryOffset: size.width / 2 + printSpan,
      exitOffset: size.width + printSpan * 2,
      iconSize: 40, titleSize: 20, bodySize: 15, captionSize: 14,
      messageWidth: min(420, size.width - 48))
  }

  /// The half-extent that puts the outermost of `bands` evenly spread slot
  /// centres exactly `outermostCentre` from the middle.
  private static func halfExtent(_ outermostCentre: CGFloat, bands: Int) -> CGFloat {
    max(0, outermostCentre) / (1 - 1 / CGFloat(bands))
  }

  /// Normalised centre of `slot`, plus a random jitter. For N columns the
  /// centres sit at the midpoints of N equal bands, so the outermost are
  /// inset by half a band rather than pinned to the edge.
  public func anchor(forSlot slot: Int) -> CGPoint {
    let columnFraction = (Double(slot % columns) + 0.5) / Double(columns)
    let rowFraction = (Double(slot / columns) + 0.5) / Double(rows)
    return CGPoint(
      x: columnFraction * 2 - 1 + Self.normalisedJitter(slotJitter, over: stageHalfWidth),
      y: rowFraction * 2 - 1 + Self.normalisedJitter(slotJitter, over: stageHalfHeight))
  }

  /// The slot whose band holds `anchor`. Prints keep their anchors across a
  /// rotation, so occupancy is judged against the current grid, not the one
  /// a print was laid out on.
  public func slot(containing anchor: CGPoint) -> Int {
    let column = min(columns - 1, max(0, Int((anchor.x + 1) / 2 * CGFloat(columns))))
    let row = min(rows - 1, max(0, Int((anchor.y + 1) / 2 * CGFloat(rows))))
    return row * columns + column
  }

  /// Offset from the stage centre, in points, for a normalised `anchor`.
  /// A print keeps the anchor it was laid out with, and an outer column of a
  /// wide grid sits further out than the outer column of a narrow one, so
  /// after a rotation the anchor is clamped to the reach of this grid's
  /// outermost jittered slot — the furthest a fresh print could land.
  public func offset(for anchor: CGPoint) -> CGSize {
    CGSize(
      width: Self.clamped(anchor.x, bands: columns, jitter: slotJitter, over: stageHalfWidth)
        * stageHalfWidth,
      height: Self.clamped(anchor.y, bands: rows, jitter: slotJitter, over: stageHalfHeight)
        * stageHalfHeight)
  }

  private static func clamped(
    _ value: CGFloat, bands: Int, jitter: CGFloat, over halfExtent: CGFloat
  ) -> CGFloat {
    let reach = 1 - 1 / CGFloat(bands) + (halfExtent > 0 ? jitter / halfExtent : 0)
    return min(reach, max(-reach, value))
  }

  private static func normalisedJitter(_ jitter: CGFloat, over halfExtent: CGFloat) -> CGFloat {
    halfExtent > 0 ? .random(in: -jitter...jitter) / halfExtent : 0
  }
}
