// ColorCurvesRibbonView.swift — Oklab secondary color curves ribbon editor,
// 6-curve selector pills, quick-anchor hue dots, Lock Skin Tone action, and
// stage-input eyedropper overlay (#5077).

import MapleCore
import MapleUI
import SwiftUI

struct ColorCurvesRibbonView: View {
  @Bindable var state: EditorState
  @State private var draggedKnotIndex: Int?
  @State private var isDragging = false

  private var picker: ColorCurvePicker { state.colorCurvePicker }
  private var activeKind: ColorCurveKind { picker.activeKind }

  private var activeCurve: ToneCurve {
    state.session.model[keyPath: activeKind.keyPath]
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      curveSelectorPills
      ribbonCanvas
      bottomToolbar
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-color-curves-view")
  }

  // MARK: - 6-Curve selector pills

  private var curveSelectorPills: some View {
    HStack(spacing: 4) {
      ForEach(ColorCurveKind.allCases) { kind in
        let isSelected = kind == activeKind
        let isModified = !state.session.model[keyPath: kind.keyPath].isIdentity
        Button {
          picker.activeKind = kind
        } label: {
          VStack(spacing: 3) {
            Text(kind.shortLabel)
              .font(.system(size: 10, weight: isSelected ? .semibold : .regular))
              .foregroundStyle(isSelected ? ProTokens.accent : ProTokens.textDim)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 3)
              .background(
                RoundedRectangle(cornerRadius: MapleTokens.Radius.sm, style: .continuous)
                  .fill(isSelected ? ProTokens.accent(0x28) : Color.clear)
              )
              .overlay(
                RoundedRectangle(cornerRadius: MapleTokens.Radius.sm, style: .continuous)
                  .stroke(isSelected ? ProTokens.accent : Color.clear, lineWidth: 0.5)
              )
            Circle()
              .fill(isModified ? ProTokens.accent : Color.clear)
              .frame(width: 3, height: 3)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(kind.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("editor-color-curve-pill-\(kind.rawValue)")
      }
    }
  }

  // MARK: - Horizontal ribbon editor

  private var ribbonCanvas: some View {
    GeometryReader { geo in
      let size = geo.size
      let pts = activeCurve.points
      ZStack {
        RoundedRectangle(cornerRadius: MapleTokens.Radius.md, style: .continuous)
          .fill(ribbonGradient)
          .opacity(0.28)
        RoundedRectangle(cornerRadius: MapleTokens.Radius.md, style: .continuous)
          .stroke(ProTokens.border, lineWidth: 0.5)

        // Neutral midline (y = 0.5)
        Path { p in
          let midY = size.height * 0.5
          p.move(to: CGPoint(x: 0, y: midY))
          p.addLine(to: CGPoint(x: size.width, y: midY))
        }
        .stroke(ProTokens.textMuted.opacity(0.45), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))

        // Evaluated spline curve
        Path { p in
          let steps = 96
          for i in 0...steps {
            let u = Double(i) / Double(steps)
            let val = activeKind.evaluate(at: u, points: pts)
            let pt = CGPoint(x: u * size.width, y: (1.0 - val) * size.height)
            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
          }
        }
        .stroke(ProTokens.accent, lineWidth: 2)

        // Knot handles
        ForEach(Array(pts.enumerated()), id: \.offset) { idx, knot in
          let cx = knot.x * size.width
          let cy = (1.0 - knot.y) * size.height
          Circle()
            .fill(ProTokens.bg)
            .frame(width: 12, height: 12)
            .overlay(Circle().stroke(ProTokens.accent, lineWidth: 2))
            .position(x: cx, y: cy)
            .onTapGesture(count: 2) {
              removeKnot(at: idx)
            }
            .accessibilityLabel("\(activeKind.title) knot \(idx + 1)")
            .accessibilityIdentifier("editor-color-curve-knot-\(idx)")
        }
      }
      .contentShape(Rectangle())
      .gesture(
        DragGesture(minimumDistance: 0)
          .onChanged { value in
            handleDrag(at: value.location, in: size)
          }
          .onEnded { _ in
            if isDragging {
              isDragging = false
              draggedKnotIndex = nil
              state.endGesture()
            }
          }
      )
    }
    .frame(height: 112)
    .accessibilityIdentifier("editor-color-curve-ribbon")
  }

  private var ribbonGradient: LinearGradient {
    if activeKind.isPeriodic {
      return LinearGradient(
        colors: [
          Color(red: 0.77, green: 0.29, blue: 0.23),
          Color(red: 0.89, green: 0.82, blue: 0.29),
          Color(red: 0.25, green: 0.68, blue: 0.42),
          Color(red: 0.27, green: 0.71, blue: 0.77),
          Color(red: 0.23, green: 0.44, blue: 0.69),
          Color(red: 0.78, green: 0.31, blue: 0.69),
          Color(red: 0.77, green: 0.29, blue: 0.23),
        ],
        startPoint: .leading,
        endPoint: .trailing
      )
    } else if activeKind == .lumaVsSat {
      return LinearGradient(
        colors: [Color.black, Color(white: 0.45), Color.white],
        startPoint: .leading,
        endPoint: .trailing
      )
    } else {
      return LinearGradient(
        colors: [Color(white: 0.35), ProTokens.accent],
        startPoint: .leading,
        endPoint: .trailing
      )
    }
  }

  // MARK: - Bottom toolbar (quick anchors, Lock Skin Tone, Eyedropper, Reset)

  private var bottomToolbar: some View {
    HStack(spacing: 6) {
      if activeKind.isPeriodic {
        ForEach(Array(ColorCurveKind.quickHueAnchors.enumerated()), id: \.offset) { _, anchor in
          Button {
            insertQuickAnchor(deg: anchor.deg)
          } label: {
            Circle()
              .fill(swatchColor(anchor.swatch))
              .frame(width: 14, height: 14)
              .overlay(Circle().stroke(ProTokens.border, lineWidth: 0.5))
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Anchor \(anchor.label)")
          .accessibilityIdentifier("editor-color-curve-anchor-\(anchor.id)")
        }

        Button {
          lockSkinTone()
        } label: {
          Text("Lock Skin")
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(ProTokens.text)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(
              RoundedRectangle(cornerRadius: MapleTokens.Radius.sm, style: .continuous)
                .fill(ProTokens.panel)
            )
            .overlay(
              RoundedRectangle(cornerRadius: MapleTokens.Radius.sm, style: .continuous)
                .stroke(ProTokens.border, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Lock Skin Tone")
        .accessibilityIdentifier("editor-color-curve-lock-skin")
      }

      Spacer(minLength: 4)

      Button {
        if picker.isArmed { picker.cancel() } else { picker.arm() }
      } label: {
        Image(systemName: "eyedropper")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(picker.isArmed ? ProTokens.accent : ProTokens.text)
          .padding(5)
          .background(
            RoundedRectangle(cornerRadius: MapleTokens.Radius.sm, style: .continuous)
              .fill(picker.isArmed ? ProTokens.accent(0x28) : ProTokens.panel)
          )
      }
      .buttonStyle(.plain)
      .disabled(!state.session.asset.isRaw)
      .accessibilityLabel("Sample color curve anchor from photo")
      .accessibilityAddTraits(picker.isArmed ? .isSelected : [])
      .accessibilityIdentifier("editor-color-curve-eyedropper")

      Button {
        resetActiveCurve()
      } label: {
        Text("Reset")
          .font(.system(size: 10, weight: .regular))
          .foregroundStyle(ProTokens.textMuted)
      }
      .buttonStyle(.plain)
      .disabled(activeCurve.isIdentity)
      .accessibilityLabel("Reset \(activeKind.title) curve")
      .accessibilityIdentifier("editor-color-curve-reset")
    }
  }

  // MARK: - Actions

  private func handleDrag(at location: CGPoint, in size: CGSize) {
    guard size.width > 1, size.height > 1 else { return }
    let u = min(max(Double(location.x / size.width), 0.0), 1.0)
    let rawY = min(max(1.0 - Double(location.y / size.height), 0.0), 1.0)
    var pts = activeCurve.points

    if !isDragging {
      isDragging = true
      state.commit(description: "Edit \(activeKind.title)")
      if let hit = pts.enumerated().min(by: {
        hypot(($0.element.x - u) * size.width, ($0.element.y - rawY) * size.height)
          < hypot(($1.element.x - u) * size.width, ($1.element.y - rawY) * size.height)
      }), hypot((hit.element.x - u) * size.width, (hit.element.y - rawY) * size.height) <= 18 {
        draggedKnotIndex = hit.offset
      } else {
        let clampedY = activeKind.clampY(forX: u, proposedY: rawY, in: pts)
        pts.append((x: u, y: clampedY))
        pts.sort { $0.x < $1.x }
        draggedKnotIndex = pts.firstIndex(where: { abs($0.x - u) < 1e-6 })
        state.session.model[keyPath: activeKind.keyPath] = ToneCurve(points: pts)
        return
      }
    }

    guard let idx = draggedKnotIndex, pts.indices.contains(idx) else { return }
    let minX = idx > 0 ? pts[idx - 1].x + 0.01 : 0.0
    let maxX = idx + 1 < pts.count ? pts[idx + 1].x - 0.01 : 1.0
    let nextX = min(max(u, minX), maxX)
    let nextY = activeKind.clampY(forX: nextX, proposedY: rawY, in: pts, excludingIndex: idx)
    pts[idx] = (x: nextX, y: nextY)
    state.session.model[keyPath: activeKind.keyPath] = ToneCurve(points: pts)
  }

  private func removeKnot(at index: Int) {
    var pts = activeCurve.points
    guard pts.indices.contains(index) else { return }
    state.commit(description: "Remove \(activeKind.title) knot")
    pts.remove(at: index)
    state.session.model[keyPath: activeKind.keyPath] = ToneCurve(points: pts)
    state.session.endEdit()
  }

  private func insertQuickAnchor(deg: Double) {
    let next = activeKind.insertingAnchor(x: deg / 360.0, y: 0.5, into: activeCurve)
    guard next != activeCurve else { return }
    state.commit(description: "Anchor \(activeKind.title)")
    state.session.model[keyPath: activeKind.keyPath] = next
    state.session.endEdit()
  }

  private func lockSkinTone() {
    let next = activeKind.lockingSkinTone(into: activeCurve)
    guard next != activeCurve else { return }
    state.commit(description: "Lock Skin Tone")
    state.session.model[keyPath: activeKind.keyPath] = next
    state.session.endEdit()
  }

  private func resetActiveCurve() {
    guard !activeCurve.isIdentity else { return }
    state.commit(description: "Reset \(activeKind.title)")
    state.session.model[keyPath: activeKind.keyPath] = .identity
    state.session.endEdit()
  }

  private func swatchColor(_ hex: UInt32) -> Color {
    Color(
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255
    )
  }
}

// MARK: - ColorCurvePickOverlay

struct ColorCurvePickOverlay: View {
  let state: EditorState
  @State private var sampleTask: Task<Void, Never>?
  private var picker: ColorCurvePicker { state.colorCurvePicker }

  var body: some View {
    GeometryReader { geometry in
      let frame = state.zoom.displayFrameInPoints ?? .zero
      let pan = state.zoom.panOffset
      let nativeSize = state.session.nativeImageSize
      let crop = state.session.model.crop
      Color.clear
        .contentShape(Rectangle())
        .onTapGesture { location in
          guard !state.session.isRendering, !picker.isSampling else { return }
          let point = WhiteBalancePickGeometry.imagePoint(
            at: location, viewport: geometry.size, displayFrame: frame,
            pan: pan, nativeSize: nativeSize, crop: crop)
          sampleTask = Task { await picker.pick(at: point) }
        }
        .accessibilityLabel("Color curve sampling canvas")
        .accessibilityIdentifier("editor-color-curve-pick-canvas")
        .overlay(alignment: .top) {
          HStack(spacing: 8) {
            Text(
              picker.message
                ?? (picker.isSampling
                  ? "Sampling colour…"
                  : "Tap the photo to place a \(picker.activeKind.title) anchor.")
            )
            .font(.caption)
            Button("Cancel") { picker.cancel() }
              .buttonStyle(.plain)
              .font(.caption.bold())
              .accessibilityIdentifier("editor-color-curve-pick-cancel")
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(.regularMaterial, in: Capsule())
          .padding(.top, 60)
        }
    }
    .onDisappear {
      sampleTask?.cancel()
      picker.cancel()
    }
  }
}
