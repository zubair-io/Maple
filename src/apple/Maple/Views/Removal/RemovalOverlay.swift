import CoreGraphics
import MapleCore
import MapleUI
import SwiftUI

struct RemovalOverlay: View {
  @Bindable var state: EditorState
  @State private var overlay: NativeRemovalOverlay?
  @State private var selectedImage: CGImage?
  @State private var protectedImage: CGImage?
  @State private var candidateImage: CGImage?
  @State private var points: [[Double]] = []
  @State private var projectionError = ""
  private var removal: RemovalSession { state.removal }

  var body: some View {
    GeometryReader { geometry in
      if let size = state.zoom.displayFrameInPoints, size.width > 0, size.height > 0 {
        let frame = CGRect(
          x: (geometry.size.width - size.width) / 2 + state.zoom.panOffset.width,
          y: (geometry.size.height - size.height) / 2 + state.zoom.panOffset.height,
          width: size.width, height: size.height)
        ZStack(alignment: .topLeading) {
          if removal.phase == .review || removal.phase == .saving {
            if !removal.compare, let candidateImage {
              Image(decorative: candidateImage, scale: 1)
                .resizable().interpolation(.high)
                .frame(width: frame.width, height: frame.height)
                .position(x: frame.midX, y: frame.midY)
                .allowsHitTesting(false)
            }
          } else {
            mask(selectedImage, color: MuiTokens.primary, frame: frame)
            mask(protectedImage, color: MuiTokens.successText, frame: frame)
            ForEach(overlay?.labels ?? [], id: \.id) { label in
              Text("\(label.id)").font(.caption.bold())
                .padding(5).background(
                  label.keep ? MuiTokens.successText : MuiTokens.primary,
                  in: Capsule()
                )
                .position(
                  x: frame.minX + label.x * frame.width,
                  y: frame.minY + label.y * frame.height
                )
                .allowsHitTesting(false)
            }
            Path { path in
              for (index, point) in points.enumerated() {
                let position = CGPoint(
                  x: frame.minX + point[0] * frame.width,
                  y: frame.minY + point[1] * frame.height)
                if index == 0 { path.move(to: position) } else { path.addLine(to: position) }
              }
            }.stroke(
              MuiTokens.primary.opacity(0.5),
              style: StrokeStyle(
                lineWidth: CGFloat(removal.radius) * 2 * min(frame.width, frame.height),
                lineCap: .round, lineJoin: .round)
            ).allowsHitTesting(false)
          }
          if removal.phase == .ready, removal.mode != .people, projectionError.isEmpty {
            Color.clear.contentShape(Rectangle()).gesture(paintGesture(frame))
          }
          if !projectionError.isEmpty {
            Text(projectionError).font(.caption).foregroundStyle(MuiTokens.errorText)
              .padding().allowsHitTesting(false)
          }
        }
        .frame(width: geometry.size.width, height: geometry.size.height)
        .clipped()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Paint to select objects")
        .accessibilityIdentifier("removal-overlay")
        .task(id: projectionKey(size)) { await refresh(size) }
        .task(id: removal.preview?.bytes) {
          candidateImage = removal.preview.flatMap {
            Self.image($0.bytes, width: Int($0.width), height: Int($0.height), alpha: false)
          }
        }
      }
    }
  }

  private func mask(_ image: CGImage?, color: Color, frame: CGRect) -> some View {
    Group {
      if let image {
        Image(decorative: image, scale: 1).renderingMode(.template)
          .resizable().interpolation(.none).foregroundStyle(color).opacity(0.38)
          .frame(width: frame.width, height: frame.height)
          .position(x: frame.midX, y: frame.midY)
      }
    }.allowsHitTesting(false)
  }

  private func paintGesture(_ frame: CGRect) -> some Gesture {
    DragGesture(minimumDistance: 0).onChanged { value in
      let point = [
        Double((value.location.x - frame.minX) / frame.width),
        Double((value.location.y - frame.minY) / frame.height),
      ]
      // Preserve outside-frame samples as breaks for the shared inverse map.
      if points.last != point { points.append(point) }
    }.onEnded { value in
      let stroke =
        points.isEmpty
        ? [
          [
            Double((value.location.x - frame.minX) / frame.width),
            Double((value.location.y - frame.minY) / frame.height),
          ]
        ] : points
      points = []
      let native = state.session.nativeImageSize
      guard native.width > 0, native.height > 0 else { return }
      Task {
        await removal.paint(stroke, cropInputSize: [UInt32(native.width), UInt32(native.height)])
      }
    }
  }

  private struct ProjectionKey: Equatable {
    let selection: Data
    let protection: Data
    let people: [Int]
    let phase: RemovalSession.Phase
    let width: CGFloat
    let height: CGFloat
  }

  private func projectionKey(_ size: CGSize) -> ProjectionKey {
    ProjectionKey(
      selection: removal.selection, protection: removal.protection,
      people: removal.people.map { $0.keep ? -$0.id : $0.id }, phase: removal.phase,
      width: size.width, height: size.height)
  }

  private func refresh(_ size: CGSize) async {
    guard removal.phase == .ready || removal.phase == .selecting else {
      overlay = nil
      selectedImage = nil
      protectedImage = nil
      projectionError = ""
      return
    }
    let native = state.session.nativeImageSize
    guard native.width > 0, native.height > 0 else { return }
    do {
      let next = try await removal.overlay(
        cropInputSize: [UInt32(native.width), UInt32(native.height)],
        aspect: size.width / size.height)
      guard !Task.isCancelled else { return }
      overlay = next
      selectedImage = Self.image(
        next.selection, width: next.width, height: next.height, alpha: true)
      protectedImage = Self.image(
        next.protection, width: next.width, height: next.height, alpha: true)
      projectionError = ""
    } catch is CancellationError {
      return
    } catch {
      guard !Task.isCancelled else { return }
      projectionError = error.localizedDescription
    }
  }

  private static func image(_ data: Data, width: Int, height: Int, alpha: Bool) -> CGImage? {
    let channels = alpha ? 4 : 3
    guard width > 0, height > 0, data.count == width * height * channels,
      let provider = CGDataProvider(data: data as CFData),
      let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
    else { return nil }
    return CGImage(
      width: width, height: height, bitsPerComponent: 8,
      bitsPerPixel: channels * 8, bytesPerRow: width * channels, space: colorSpace,
      bitmapInfo: CGBitmapInfo(
        rawValue: alpha
          ? CGImageAlphaInfo.premultipliedLast.rawValue
          : CGImageAlphaInfo.none.rawValue), provider: provider, decode: nil,
      shouldInterpolate: false, intent: .defaultIntent)
  }
}
