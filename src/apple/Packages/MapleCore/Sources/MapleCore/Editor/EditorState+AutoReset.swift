// EditorState+AutoReset.swift — AUTO (#1379) and RESET (#1372 / #1108)
// methods: reset-to-factory, reset the armed tool, reset a group, and AUTO.
//
// Pure code-move from EditorState.swift to clear the 600-LOC file budget.
// Stored properties (`autoInProgress`, `autoGeneration`, `autoProvider`)
// remain in the main class body — stored properties cannot live in
// extensions on @Observable classes.

import Foundation

extension EditorState {

  // MARK: Per-tool and per-group reset (#1108)

  /// Reset only the armed (tool, subParam) pair to its canonical
  /// default. Defaults mirror the generated `AdjustmentModel` field
  /// defaults (Color NR = 25, Sharpen = 40, Temp = 6500) so a fresh
  /// asset never reads as "modified" and reset returns to the same
  /// value the model was born with. On a multi-param tool only the
  /// ARMED sub-param resets — the others keep their values (#1108).
  public func resetArmedTool() {
    // The guard skips wired-but-value-less tools (presets, #1115) so
    // they can't push junk undo entries.
    guard armedToolAcceptsValueEdits else { return }
    // A reset is an explicit, discrete edit — it always writes through,
    // even for a commit-on-release sub-param (#1153).
    cancelGesture()
    commit(kind: .reset, description: "Reset \(armedTool.displayName)")
    if let sub = armedSubParam {
      setArmedDisplayValue(sub.defaultDisplayValue)
    } else {
      setArmedDisplayValue(ToolValueMapping.defaultDisplayValue(for: armedTool))
    }
    session.endEdit()
  }

  /// Reset every tool in `group` to its canonical default as a SINGLE
  /// undo boundary: compute the reset, then batch-apply changed defaults
  /// without arming each tool (arming per tool would spawn extra
  /// crop-session transitions and undo entries).
  ///
  /// Tools with a tool-level display range reset through
  /// `ToolValueMapping` exactly as before. Tools that have NO
  /// tool-level range but do declare sub-params — HSL is the only one
  /// (#274), with 24 band fields and no primary — reset every declared
  /// sub-param instead; otherwise "Reset Color" would silently leave
  /// all 24 HSL fields set. Multi-param tools that DO have a
  /// tool-level range keep their existing primary-only semantics.
  public func resetGroup(_ group: ToolGroup) {
    let tools = Tool.tools(in: group).filter(\.isWired)
    guard !tools.isEmpty else { return }
    var reset = session.model
    for tool in tools {
      if ToolValueMapping.displayRange(for: tool) != nil {
        ToolValueMapping.apply(
          ToolValueMapping.defaultDisplayValue(for: tool),
          to: &reset,
          tool: tool
        )
      } else {
        for sub in tool.subParams {
          reset[keyPath: sub.keyPath] = sub.defaultDisplayValue
        }
      }
    }
    guard reset != session.model else { return }
    commit(kind: .reset, description: "Reset \(group.displayName)")
    session.model = reset
    session.endEdit()
  }

  // MARK: Reset to factory defaults (#1372)

  /// Reset every develop slider to its FACTORY default, point white balance
  /// at the camera's As-Shot reading (falling back to the 6500 K / 0 default
  /// when no As-Shot value was captured), and restore the Auto profile.
  /// Crop / rotation is deliberately preserved — RESET clears develop
  /// adjustments, never the user's framing. Applied as ONE undo entry
  /// (`commit()` then a single `session.model` write, mirroring
  /// `applyPreset`). (#1372)
  public func resetToFactoryDefaults() {
    commit(kind: .reset, description: "Reset all adjustments")
    defer { session.endEdit() }
    var m = AdjustmentModel.default
    m.crop = session.model.crop  // preserve crop / rotation
    if let cct = session.asShotCCT, let tint = session.asShotTint {
      m.temperature = cct
      m.tint = tint
    }
    m.profile = .auto
    session.model = m
  }

  // MARK: AUTO (#1379)

  /// Analyse the scene and apply AUTO's **exposure + the five calibrated
  /// tone sliders and white balance** (#1376/#2255/#3307) as ONE undo entry (`commit()` then a
  /// single `session.model` write). Async — the analysis decodes + develops
  /// a probe buffer. Generation-guarded so a stale result can't overwrite a
  /// newer edit / image switch.
  ///
  /// White balance uses the clip-aware estimator corrected in #2247. Auto
  /// records its explicit pair, current scale and algorithm provenance.
  /// `whiteBalanceOnly` serves the WB picker's Auto choice without changing tone.
  ///
  /// AE contract: AUTO's exposure is measured against an AE-Off probe. On the
  /// default `Profile.auto` the Apple decode already forces auto-exposure off
  /// internally whenever an Auto Profile curve will fit, so the recommendation
  /// lands correctly there regardless; on `Profile.neutral`
  /// nothing forces that, so applying AUTO's exposure on top of an AE-On decode
  /// would double-count the anchor gain and blow out highlights. #1387 closes
  /// that gap: `autoExposure` is set to `.off` alongside `exposure`, on every
  /// profile, so the decode this recommendation is valid for is always the one
  /// that actually renders.
  public func applyAuto(whiteBalanceOnly: Bool = false) async {
    let asset = session.asset
    guard asset.isRaw else { return }
    whiteBalancePicker.cancel()
    autoGeneration &+= 1
    let gen = autoGeneration
    let originalModel = session.model
    let editID = session.transactions.nextID
    autoInProgress = true
    defer { if gen == autoGeneration { autoInProgress = false } }

    let result: AutoAdjustmentsResult
    do {
      // PhotoKit/cloud originals use the same session-owned staged file as
      // Auto Profile. The path-only FFI therefore works for every RAW source.
      let url = try await session.renderActor.rawRenderSource.url(for: asset)
      guard !Task.isCancelled, gen == autoGeneration,
        session.model == originalModel, session.transactions.nextID == editID
      else { return }
      // A bookmark-granted parent is the sandbox capability for a local
      // original. Keep it live through the detached native analysis.
      let scope = asset.scopeParentURL ?? url
      let accessing = scope.startAccessingSecurityScopedResource()
      defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
      result = try await autoProvider(url)
    } catch {
      return  // leave the model untouched; the button re-enables
    }
    // The chrome task is cancelled when its editor disappears. A native
    // analysis can finish after cancellation; it must not commit to the
    // session (or its sidecar) after the user has left the image.
    // The model catches in-progress slider writes; the transaction ID also
    // catches edit → undo while analysis runs, when the model matches again.
    guard !Task.isCancelled, gen == autoGeneration, session.asset.id == asset.id,
      session.model == originalModel, session.transactions.nextID == editID
    else { return }

    func clamp(_ v: Double, _ r: ClosedRange<Double>) -> Double {
      min(max(v, r.lowerBound), r.upperBound)
    }
    var m = session.model
    guard
      [
        result.temperature, result.tint, result.exposure, result.contrast,
        result.highlights, result.shadows, result.whites, result.blacks,
      ].allSatisfy(\.isFinite)
    else { return }
    if !whiteBalanceOnly {
      m.exposure = clamp(result.exposure, AdjustmentModel.exposureRange)
      m.contrast = clamp(result.contrast, AdjustmentModel.contrastRange)
      m.highlights = clamp(result.highlights, AdjustmentModel.highlightsRange)
      m.shadows = clamp(result.shadows, AdjustmentModel.shadowsRange)
      m.whites = clamp(result.whites, AdjustmentModel.whitesRange)
      m.blacks = clamp(result.blacks, AdjustmentModel.blacksRange)
      // The exposure recommendation replaces the AE-Off probe's anchor.
      m.autoExposure = .off
    }
    m.temperature = clamp(result.temperature, AdjustmentModel.temperatureRange)
    m.tint = clamp(result.tint, AdjustmentModel.tintRange)
    m.wbScaleVersion = AdjustmentModel.default.wbScaleVersion
    m.whiteBalancePreset = .auto
    m.wbSource = .auto
    m.wbSampleX = 0
    m.wbSampleY = 0
    m.wbAlgorithmVersion = autoWhiteBalanceAlgorithmVersion
    // Beginning even an unchanged transaction would clear the redo stack.
    guard m != session.model else { return }
    commit(kind: .auto, description: whiteBalanceOnly ? "Auto white balance" : "Auto adjustments")
    defer { session.endEdit() }
    session.model = m
  }
}
