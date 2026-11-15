import MapleCore
import MapleUI
import SwiftUI

struct PanoSeamEditor: View {
  let session: PanoMergeSession

  @Environment(\.dismiss) private var dismiss
  @State private var frame = "0"
  @State private var kind = "include"
  @State private var x = "0"
  @State private var y = "0"
  @State private var width = "1"
  @State private var height = "1"
  @State private var error: String?
  @GestureState private var drag: SeamDrag?

  private struct SeamDrag {
    let start: CGPoint
    var end: CGPoint
    let frame: Int
    let kind: SeamConstraintsRequest.Kind
  }

  private var canvas: SeamConstraintsRequest.Canvas {
    session.options.seamConstraints?.canvas
      ?? .init(
        width: session.lastPreview?.image.width ?? 0,
        height: session.lastPreview?.image.height ?? 0)
  }

  private var regions: [SeamConstraintsRequest.Region] {
    session.options.seamConstraints?.regions ?? []
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
          if let preview = session.lastPreview {
            previewCanvas(preview)
          }
          Text(
            "Choose a source frame, then drag a rectangle or enter coordinates below. Include uses that frame; Exclude avoids it."
          )
          .font(.subheadline)
          Text(
            "Reference canvas: \(canvas.width) × \(canvas.height) pixels, before Auto Crop. Geometry changes clear regions."
          )
          .font(.caption)
          .foregroundStyle(MuiTokens.textMuted)
          .accessibilityIdentifier("pano-seam-reference")
          Text(
            "Regions use graph-cut seams. Auto projection may refuse tile mosaics; choose Rotation in that case. Create Panorama uses these regions after you close this editor."
          )
          .font(.caption)
          .foregroundStyle(MuiTokens.textMuted)
          if let reason = session.seamAuthoringDisabledReason {
            Text(reason)
              .font(.subheadline)
              .foregroundStyle(MuiTokens.warn)
              .accessibilityIdentifier("pano-seam-disabled-reason")
          }
          selectors
          numericFields
          if let error {
            errorMessage(error)
          }
          actions
          previewStatus
          regionList
        }
        .padding(MuiTokens.spacingMd)
      }
      .accessibilityIdentifier("pano-seam-scroll")
      #if os(iOS)
        .scrollDismissesKeyboard(.interactively)
      #endif
      .foregroundStyle(MuiTokens.textMain)
      .background(MuiTokens.surface)
      .navigationTitle("Seam Regions")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
            .accessibilityLabel("Close seam region editor")
            .accessibilityIdentifier("pano-seam-done")
        }
      }
    }
    .frame(minWidth: 300, idealWidth: 560, idealHeight: 700)
    .onChange(of: session.seamFrames.map(\.id)) { _, _ in
      frame = "0"
      error = nil
    }
  }

  private var selectors: some View {
    VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
      Text("Source frame").font(.subheadline)
      MuiSelect(
        value: $frame,
        options: session.seamFrames.enumerated().map { index, asset in
          .init(
            value: String(index),
            label:
              "\(index + 1): \(asset.path)"
          )
        },
        accessibilityLabel: "Seam source frame",
        disabled: !session.seamAuthoringAvailable
      )
      .accessibilityIdentifier("pano-seam-frame")
      Text("Region mode").font(.subheadline)
      MuiSelect(
        value: $kind,
        options: [
          .init(value: "include", label: "Include — use this frame"),
          .init(value: "exclude", label: "Exclude — avoid this frame"),
        ],
        accessibilityLabel: "Seam region mode",
        disabled: !session.seamAuthoringAvailable
      )
      .accessibilityIdentifier("pano-seam-kind")
    }
  }

  private var numericFields: some View {
    LazyVGrid(
      columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: MuiTokens.spacingSm
    ) {
      numericField("X", value: $x)
      numericField("Y", value: $y)
      numericField("Width", value: $width)
      numericField("Height", value: $height)
    }
  }

  private func numericField(_ label: String, value: Binding<String>) -> some View {
    VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
      Text(label).font(.subheadline)
      MuiInput(
        value: value, accessibilityLabel: "Seam region \(label)",
        placeholder: "Seam region \(label)",
        disabled: !session.seamAuthoringAvailable, onCommit: addNumeric,
        monospaced: true, keyboard: .numberPad
      )
      .accessibilityIdentifier("pano-seam-\(label.lowercased())")
    }
  }

  private var actions: some View {
    VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: MuiTokens.spacingSm) {
          addButton
          clearButton
        }
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
          addButton
          clearButton
        }
      }
      MuiButton(
        label: "Preview Regions", variant: .primary,
        disabled: !session.seamAuthoringAvailable
      ) {
        error = nil
        session.previewSeamConstraints()
      }
      .accessibilityLabel("Preview panorama with seam regions")
      .accessibilityIdentifier("pano-seam-preview")
    }
  }

  private var addButton: some View {
    MuiButton(label: "Add Region", disabled: !session.seamAuthoringAvailable, action: addNumeric)
      .accessibilityLabel("Add seam region from numeric coordinates")
      .accessibilityIdentifier("pano-seam-add")
  }

  private var clearButton: some View {
    MuiButton(
      label: "Clear Regions", variant: .ghost,
      disabled: session.isRunning || session.isPreviewing || regions.isEmpty
    ) {
      session.setSeamConstraints(nil)
      error = nil
    }
    .accessibilityLabel("Clear all seam regions")
    .accessibilityIdentifier("pano-seam-clear")
  }

  @ViewBuilder
  private var previewStatus: some View {
    switch session.previewState {
    case .scheduled, .running:
      ProgressView("Building constrained panorama preview…")
        .accessibilityLabel("Building constrained panorama preview")
    case .failed(let failure):
      errorMessage(failure.message)
    case .idle, .ready:
      EmptyView()
    }
  }

  private func errorMessage(_ message: String) -> some View {
    Text(message)
      .font(.subheadline)
      .foregroundStyle(MuiTokens.errorText)
      .accessibilityLabel("Seam region error: \(message)")
      .accessibilityIdentifier("pano-seam-error")
      .onAppear { AccessibilityNotification.Announcement(message).post() }
  }

  private var regionList: some View {
    VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
      Text("\(regions.count) seam regions")
        .font(.subheadline)
        .accessibilityIdentifier("pano-seam-count")
      ForEach(Array(regions.enumerated()), id: \.offset) { index, region in
        HStack(alignment: .top) {
          Text(
            "\(index + 1). \(region.kind == .include ? "Include" : "Exclude") frame \(region.frame + 1): X \(region.rect.x), Y \(region.rect.y), width \(region.rect.width), height \(region.rect.height)"
          )
          .font(.caption)
          .frame(maxWidth: .infinity, alignment: .leading)
          MuiButton(
            label: "Remove", variant: .ghost,
            disabled: session.isRunning || session.isPreviewing
          ) {
            var remaining = regions
            remaining.remove(at: index)
            session.setSeamConstraints(
              remaining.isEmpty ? nil : .init(canvas: canvas, regions: remaining))
            error = nil
          }
          .accessibilityLabel("Remove seam region \(index + 1)")
          .accessibilityIdentifier("pano-seam-remove-\(index + 1)")
        }
      }
    }
  }

  private func previewCanvas(_ preview: PanoPreview) -> some View {
    GeometryReader { geometry in
      let aspect = CGFloat(preview.image.width) / CGFloat(preview.image.height)
      let imageWidth = min(geometry.size.width, 240 * aspect)
      let size = CGSize(width: imageWidth, height: imageWidth / aspect)
      ZStack(alignment: .topLeading) {
        Image(decorative: preview.image, scale: 1)
          .resizable()
          .frame(width: size.width, height: size.height)
        ForEach(Array(regions.enumerated()), id: \.offset) { index, region in
          regionOverlay(
            region.rect, kind: region.kind,
            label:
              "\(index + 1): \(region.kind == .include ? "Include" : "Exclude") \(region.frame + 1)",
            size: size)
        }
        if let drag, let rect = dragRect(drag) {
          regionOverlay(rect, kind: drag.kind, label: "New region", size: size)
        }
      }
      .frame(width: size.width, height: size.height)
      .contentShape(Rectangle())
      .gesture(drawGesture(size: size))
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(
        "Uncropped panorama seam canvas, \(canvas.width) by \(canvas.height) pixels"
      )
      .accessibilityHint(
        "Drag to add a rectangle, or use the labeled numeric coordinate fields below"
      )
      .accessibilityIdentifier("pano-seam-canvas")
      .opacity(session.seamAuthoringAvailable ? 1 : 0.45)
      .frame(width: geometry.size.width, height: 240)
    }
    .frame(height: 240)
  }

  private func regionOverlay(
    _ rect: SeamConstraintsRequest.Rect,
    kind: SeamConstraintsRequest.Kind, label: String, size: CGSize
  ) -> some View {
    let scaleX = size.width / CGFloat(max(1, canvas.width))
    let scaleY = size.height / CGFloat(max(1, canvas.height))
    let color = kind == .include ? MuiTokens.primary : MuiTokens.warn
    return Rectangle()
      .fill(color.opacity(0.15))
      .overlay(
        Rectangle().stroke(
          color, style: StrokeStyle(lineWidth: 2, dash: kind == .exclude ? [5, 3] : []))
      )
      .overlay(alignment: .topLeading) {
        Text(label).font(.caption2.bold())
          .foregroundStyle(MuiTokens.textMain)
          .padding(2)
          .background(MuiTokens.surface)
          .fixedSize()
      }
      .frame(width: CGFloat(rect.width) * scaleX, height: CGFloat(rect.height) * scaleY)
      .offset(x: CGFloat(rect.x) * scaleX, y: CGFloat(rect.y) * scaleY)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
  }

  private func drawGesture(size: CGSize) -> some Gesture {
    DragGesture(minimumDistance: 0)
      .updating($drag) { value, state, _ in
        guard session.seamAuthoringAvailable else {
          state = nil
          return
        }
        let point = referencePoint(value.location, size: size)
        if state == nil {
          state = SeamDrag(
            start: referencePoint(value.startLocation, size: size), end: point,
            frame: Int(frame) ?? -1, kind: kind == "include" ? .include : .exclude)
        } else {
          state?.end = point
        }
      }
      .onEnded { value in
        var completed =
          drag
          ?? SeamDrag(
            start: referencePoint(value.startLocation, size: size),
            end: referencePoint(value.location, size: size),
            frame: Int(frame) ?? -1, kind: kind == "include" ? .include : .exclude)
        completed.end = referencePoint(value.location, size: size)
        if let rect = dragRect(completed) {
          add(rect, frame: completed.frame, kind: completed.kind)
        }
      }
  }

  private func referencePoint(_ point: CGPoint, size: CGSize) -> CGPoint {
    CGPoint(
      x: min(CGFloat(canvas.width), max(0, point.x * CGFloat(canvas.width) / max(1, size.width))),
      y: min(CGFloat(canvas.height), max(0, point.y * CGFloat(canvas.height) / max(1, size.height)))
    )
  }

  private func dragRect(_ drag: SeamDrag) -> SeamConstraintsRequest.Rect? {
    guard drag.start.x != drag.end.x, drag.start.y != drag.end.y else { return nil }
    let left = Int(min(drag.start.x, drag.end.x).rounded(.down))
    let top = Int(min(drag.start.y, drag.end.y).rounded(.down))
    let right = Int(max(drag.start.x, drag.end.x).rounded(.up))
    let bottom = Int(max(drag.start.y, drag.end.y).rounded(.up))
    return .init(x: left, y: top, width: right - left, height: bottom - top)
  }

  private func addNumeric() {
    guard let x = Int(x.trimmingCharacters(in: .whitespacesAndNewlines)),
      let y = Int(y.trimmingCharacters(in: .whitespacesAndNewlines)),
      let width = Int(width.trimmingCharacters(in: .whitespacesAndNewlines)),
      let height = Int(height.trimmingCharacters(in: .whitespacesAndNewlines))
    else {
      error = "Enter X, Y, width and height as whole preview pixels."
      return
    }
    add(
      .init(x: x, y: y, width: width, height: height),
      frame: Int(frame) ?? -1, kind: kind == "include" ? .include : .exclude)
  }

  private func add(
    _ rect: SeamConstraintsRequest.Rect, frame: Int, kind: SeamConstraintsRequest.Kind
  ) {
    guard session.seamAuthoringAvailable else { return }
    let request = SeamConstraintsRequest(
      canvas: canvas, regions: regions + [.init(frame: frame, kind: kind, rect: rect)])
    do {
      try request.validate(frameCount: session.seamFrames.count)
      session.setSeamConstraints(request)
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }
}
