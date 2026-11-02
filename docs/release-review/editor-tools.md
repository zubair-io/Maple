# Release review: editor tools (Area 4, v0.1.6)

Static code review of `origin/main`. Rows T1-T9 of the feature story map. "Reviewed" means the cited code was read; nothing here was exercised on a device or against RAW fixtures.

| ID | Feature | Verdict | Findings |
|---|---|---|---|
| T1 | Crop + straighten | works | Crop group is gated by `crs:HasCrop`, angle independent; serializers and parsers agree in Swift, TS and Rust (`XMPSerialization+Attrs.swift:360`, `xmp-crop.ts`, `xmp/fields.rs:394`). Reset preserves crop on both Apple and Web by design. |
| T2 | Manual + guided geometry | works with P2 | Homography composition and guided solver reviewed (`stages/perspective/`). P2: `crs:Perspective*` values are not clamped to slider ranges when read from a sidecar (`xmp/fields.rs:23`); only non-finite values are rejected. |
| T3 | Presets | works with P2 | Web and Apple capture/apply are sparse and clamp numerics. P2: Apple `numericRange` has no entry for `parametricShadowSplit`, `parametricMidtoneSplit`, `parametricHighlightSplit`, so a preset applies those unclamped (`PresetAdjustmentBridge.swift`, `numericRange`); Web clamps via `ADJUSTMENT_RANGES`. |
| T4 | AUTO, Reset, undo/redo | works | One undo entry per AUTO/Reset on both platforms; stale-result guards present (`editor-state.auto.ts`, `EditSession+UndoRedo.swift`). Known open: #5388. |
| T5 | Copy/paste/sync, batch ledger | works | Per-asset durable records, prepared patch replayed idempotently, sidecar re-validated before write, write under a Web Lock (`persistent-batch-runner.ts`, `batch-sync-asset-io.service.ts`). Apple and Windows ledgers not reviewed. |
| T6 | Masks | not fully reviewed | Local-adjustment orientation mapping exists (`pipeline/mask/mod.rs`, #4426). 17 local controls confirmed in `PartialAdjustments`. Per-platform mask UIs not reviewed. |
| T7 | Clone / heal | broken (P0) | See below. |
| T8 | Editor chrome | not reviewed | Not covered. |
| T9 | Deep zoom | not reviewed in depth | `NativeDetailRenderer` reads fine; tile path refuses retouch spots that do not fit the window and falls back to a whole-image render. |

## P0: retouch spots are applied in the sensor frame but authored upright (#4473)

`capture_prefix` (`raw-core/src/pipeline/capture_first/mod.rs`) applies `retouch_spots` to the sensor-framed buffer. Apple (`RetouchOverlayGeometry.swift`) and Web (`retouch-geometry.ts`) author spots over the upright image, the same convention masks use. Masks are mapped with `display_to_sensor_norm`; spots are not.

Failing scenario: portrait iPhone DNG (EXIF orientation 6). The user clicks a dust spot at upright (0.31, 0.32). The render heals sensor-frame (0.31, 0.32), a different place, and the clone/heal radius uses the wrong axis length.

Status: a fix with a rotated-versus-upright-twin test (fails before, passes after) exists locally on branch `keep/retouch-orient-fix` in the review worktree and is not pushed. It cannot land alone: Windows stores spots as decode-frame (sensor) fractions and pre-rotates them itself (`Models/RetouchState.cs`, `Services/RepairCanvasMap.cs`, `docs/xmp-canonical-format.md` "Repair spots"), so a core-only fix would double-map Windows-authored spots, and Windows spots already differ from Apple/Web sidecars on rotated RAWs. This needs a decision on the sidecar frame contract (upright everywhere, with Windows changed and a stamp or accepted breakage for existing Windows sidecars) before it ships.

## Not verified

Runtime behaviour on any platform, Windows editor paths, Apple batch ledger, mask UIs, editor chrome and keyboard routing (T8).
