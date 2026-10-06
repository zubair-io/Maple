# Maple AI Object Removal PRD

Snapshot of the canonical [Page](https://chatgpt.com/space/page_4c1035a13efc8191b39a4a264e32144d) on October 5, 2026. Live Page remains authoritative.

**Status:** Research checkpoint; feature not release-qualified. **Updated:** October 5, 2026. Mac feasibility comes first; other platforms follow qualification.

## October 5 research checkpoint

[Code, evidence and session handoff](https://github.com/zubair-io/Maple/blob/codex/removal-research-handoff/tools/removal/research/2026-10-05/README.md) · [Active quality investigation #3941](https://github.com/zubair-io/Maple/issues/3941).

Completed: 90 comparison generations (LaMa 512/768/1024, FLUX.2 Klein 4B 512/1024, Qwen Image Edit 2511 512) and 24 matched LaMa/Qwen mask-expansion generations. Both LaMa and Qwen remain useful research candidates; neither is a qualified production winner. Expanded masks improve some boundaries, but Qwen can still regenerate people and indoor floor artifacts persist.

The model sees a downsampled RGB context crop. Current native-size outputs use bilinear enlargement; they do not demonstrate native generated detail. RAW exposure/WB and outside-mask checks are distinct from perceptual fill quality. Case 5's saved results lack calibrated RAW/WB qualification; #4283 is now closed, which does not retroactively validate those outputs.

The next proposed investigation is native-detail reconstruction from fixed successful coarse fills, tracked in #3941. It has not started. Quality is the current experiment priority; production latency, memory, portability and colour gates remain required before shipping.

People selection should be an accessible multi-select list. On entering the people tab, detect and preselect likely background people conservatively. The main subject stays unselected. Remove applies the current choices automatically; omit separate Suggest Background People and Apply Person buttons.

Maple AI Object Removal lets a photographer select unwanted people or objects, reconstruct the obscured background, and continue developing the original RAW. It provides three selection modes through one removal workflow and preserves every accepted result as an editable, non-destructive operation.

This PRD defines the intended product. The existing [Local AI Inpainting epic](https://github.com/zubair-io/Maple/issues/1472) supplies the prototype foundation; current work focuses on Mac feasibility before porting. The [engineering RFC](https://chatgpt.com/space/page_7fd972e84c3c81919405004ebda76895) defines the proposed implementation and qualification gates. Experimental UI and promising standalone fills do not establish a finished feature.

## Problem and product outcome

Photographers often have an otherwise usable image interrupted by passers-by, a sign, a bag, or another distraction. Leaving Maple for a raster editor interrupts the RAW workflow and makes it harder to revisit colour and exposure.

The intended outcome is that the photographer can select the distraction, review a reconstructed result at fit view and 100 percent, keep it, and continue editing in Maple. Synthetic replacement pixels must remain distinguishable from original sensor data in the editing model, even though both participate in downstream development.

A successful tool preserves the intended subject, removes visible edge remnants, matches the surrounding scene, and survives reopening, export, backup, and transfer between Maple clients.

## Users and scenarios

| Scenario                                              | Required outcome                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Travel or architecture image with multiple bystanders | Suggest individual background people, allow people to be kept, then remove the selected set.    |
| Portrait with a bag or distracting object             | A rough smart brush stroke selects the object without selecting the portrait subject.           |
| Landscape with an irregular distraction               | Manual painting controls the exact intended region.                                             |
| High ISO image                                        | The replacement does not form a visibly smooth island inside the surrounding texture and noise. |
| 100MP image inspected at 100 percent                  | Replacement detail remains credible at native output resolution.                                |
| Edit reopened on another Maple client                 | The same accepted patch is rendered without running the model again.                            |

## Scope and platform coverage

The current implementation priority is macOS. Paint, Smart paint, and Background people remain the intended selection modes. Port to iPadOS, iOS, and Web after Mac reconstruction and RAW behavior qualify; their authoring support is not a condition for running the current Mac experiment. Shared accepted-mask/patch semantics and portable rendering remain the eventual product contract.

Hardware and browser support tiers must be established by the RFC qualification work before release. A device that cannot author removals must still display supported saved removals when its rendering path qualifies. Missing capabilities receive an explicit explanation and a usable recovery path.

CLI, API, and Windows rendering and sidecar preservation are part of the portability contract wherever those consumers open or export edited assets. Windows selection authoring is outside this first UI release.

**Proposed default:** processing runs locally after required models are provisioned. No photo content is uploaded for this feature in the first release. Optional cloud reconstruction is a separate product decision; it was discussed but has not been selected.

Outside scope: text-prompt generation, adding objects, background replacement, automatic cast-shadow inference, batch detection/removal, removal transfer through Copy/Paste settings, and claims of Adobe-compatible rendering of Maple-private removal records. Initial quality qualification targets RAW images; JPEG/HEIF authoring needs separate qualification before exposure.

## Entry point and shared workflow

Add Remove alongside the existing Heal and Clone modes in the repair tool. It has a selection-mode control with Paint, Smart paint, and Background people. Reuse Maple UI button, segmented-toggle, list-row, progress, status, and overlay conventions; do not expose model names or colour-space machinery in the normal editing flow.

1. Open Remove and choose a selection mode.

2. Create or review a selection. Add/Erase can refine it, including carried objects, shadows, and reflections.

3. Select Remove. Maple preserves the selection and shows cancellable progress.

4. Inspect the original and candidate results at fit view and 100 percent. The current design direction retains both LaMa and Qwen: request both for the same selection, show the first completed result while the other remains pending, and let the photographer choose. Candidate labels can be Result A/B; model details belong in provenance. This interaction is proposed, not implemented.

5. Select Keep, Retry, or Edit selection. Keep creates one committed removal transaction; Retry produces a new candidate without replacing the committed edit.

6. Continue RAW development or select an accepted removal from the list to disable, delete, or replace it.

Candidate inspection must use the same visible development settings as the editor, including the default Auto profile. Selection work has its own undoable strokes; each accepted addition, replacement, toggle, or deletion is one editor undo transaction. Discarding a candidate leaves the committed image unchanged.

## Selection requirements

| ID   | Requirement                                              | Acceptance                                                                                                                                                   |
| ---- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SEL1 | Paint selects the area the photographer brushes.         | Add/Erase, size, pen/touch/mouse input, zoom/pan, and stroke undo work consistently.                                                                         |
| SEL2 | Smart paint expands a rough stroke into an object mask.  | Positive and negative strokes refine the mask; stale inference never overwrites newer strokes.                                                               |
| SEL3 | Background people proposes individual person selections. | Each person can be kept or removed through a pin and an accessible list; uncertain instances are visibly distinguishable.                                    |
| SEL4 | Protect the intended subject.                            | Remove previews a candidate; committed pixels change only at Keep. Likely subjects are excluded conservatively, and every proposed selection is correctable. |
| SEL5 | Allow residual selection.                                | The user can manually add shadows, reflections, belongings, or missed fragments before removal.                                                              |
| SEL6 | Maintain spatial alignment.                              | The mask stays attached to the same source region through zoom, orientation, crop, straighten, and perspective changes.                                      |

Finding all people is an aspiration to measure, not a guarantee of perfect detection. Report no detections distinctly from an inference failure. Never treat every detected person as a bystander or promise that shadows are selected automatically.

## Reconstruction and RAW requirements

| ID    | Requirement                     | Acceptance                                                                                                                                              |
| ----- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RAW1  | Preserve originals.             | Original content hashes are unchanged after generation, Keep, undo, reopen, and export.                                                                 |
| RAW2  | Preserve RAW development.       | Accepted scene-linear replacement pixels participate in the qualified downstream exposure, WB, colour, local-adjustment, and display paths.             |
| RAW3  | Preserve default Auto behavior. | Entering Remove never switches the visible profile or bakes the current creative grade into the patch.                                                  |
| QUAL1 | Eliminate edge remnants.        | Qualified masks and blend boundaries do not leave clothing, hair, or colour halos in the challenge corpus.                                              |
| QUAL2 | Preserve surrounding detail.    | No source pixels change outside the defined replacement/blend support; wider effects of downstream spatial filters remain consistent with the pipeline. |
| QUAL3 | Support native resolution.      | Keep requires a final qualified patch, and export never substitutes a fit-preview patch enlarged to native resolution.                                  |
| QUAL4 | Match texture and noise.        | Quality evaluation includes high ISO, foliage, water, architecture, bright windows, sunsets, and overlap with kept subjects.                            |

The tool reconstructs plausible content. It cannot recover hidden sensor measurements or guarantee that an invented region retains the original scene's dynamic range. Quality under later exposure/WB changes is a release gate.

## Edit history and persistence requirements

| ID    | Requirement                     | Acceptance                                                                                                                                     |
| ----- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| DATA1 | Persist the accepted result.    | XMP identifies the operation and its mask/patch assets; reopen does not depend on model availability.                                          |
| DATA2 | Preserve edit assets.           | Cache clearing cannot delete accepted patches, selection masks, or assets still referenced by history.                                         |
| DATA3 | Preserve portability.           | Backup, move, copy, synchronization, and an explicit edit-package export carry the RAW reference, XMP, and required removal assets together.   |
| DATA4 | Surface incomplete edits.       | Missing, corrupt, incompatible, or mismatched assets produce a visible incomplete-edit state; export refuses to silently omit active removals. |
| DATA5 | Preserve accepted pixels.       | Model upgrades, Retry, upstream edits, or another client's runtime never silently regenerate a kept result.                                    |
| DATA6 | Make overlap behavior explicit. | Later patches remain baked when earlier removals are toggled; an overlapping dependent result is marked as needing review.                     |

Browser-local edits must distinguish Stored locally from Backed up or Synced. Browser storage can be evicted; provide an exportable edit package and never imply that local browser persistence is a backup. Read-only sources must resolve a writable companion destination before Keep.

## Responsiveness and failure behavior

The existing slider target remains 16ms with the 50ms hard limit on Maple's reference set. Generation is asynchronous and has a separate budget. It must not allocate new removal resources or invoke inference on every slider tick.

Proposed interaction targets to validate: brush/overlay feedback within one 60Hz frame; warm smart-selection refinement at p95 within 250ms. Detection, reconstruction, model startup, and memory limits must be measured per device tier before numeric shipping budgets are ratified. These are proposed targets, not benchmark results.

Model download, unsupported runtime, insufficient memory/storage, cancellation, and inference failure must preserve existing edits and the selection. Progress must reflect real work; use an indeterminate state when a reliable percentage is unavailable. The user can cancel or navigate away, and late results cannot commit to another image.

If a large selected region exceeds the qualified reconstruction limit, explain that limit and let the user refine the selection. Do not silently lower export quality.

## Accessibility and responsive behavior

The person list, removal list, selection-mode control, Add/Erase, Remove, Cancel, Keep, Retry, and before/after controls need accessible labels, focus states, and stable automation identifiers. Colour alone must not encode selected, protected, uncertain, or failed states.

Desktop and tablet use the existing inspector/tool-panel area. Phone uses the established compact controls without covering the entire image. Preserve the edit session during layout changes. Provide keyboard access to detected people and accepted removals. Manual painting remains a spatial interaction, but list-based selection and review actions must work with assistive technology.

## Measurement and release acceptance

Maintain a consented challenge corpus with manual person/object masks, retained-subject labels, and representative camera RAWs, including the 100MP reference scene. Measure selection overlap and boundary error, retained-subject false selection, reconstruction artifacts, boundary colour error, texture/noise statistics, end-to-end latency, and peak memory.

Use objective colour/parity tests for pipeline correctness and structured visual assessment for the plausibility of generated content. An ACR reference cannot establish the truth of an invented background.

A Mac release requires all intended selection modes, complete persistence and recovery, qualified native-resolution reconstruction, accessibility, and fresh colour/parity/performance evidence. Later platform ports must meet the same saved-edit rendering contract and qualify their own authoring paths. A skipped corpus is not release qualification.

Keep image content, masks, and inferred people out of diagnostics by default. Aggregate quality metrics may come from consented evaluation; this PRD does not authorize production image collection.

## Delivery milestones and open decisions

| Milestone                   | Exit condition                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| RAW qualification           | Controlled inference rendering and patch conversion pass actual camera-WB, Auto, exposure-push, geometry, and native-detail tests. |
| Model qualification         | A selection model and local inpainter are chosen from measured quality, licensing, runtime, and memory evidence.                   |
| Persistent edit integration | XMP, assets, history, storage adapters, export, and recovery work across the required consumers.                                   |
| Complete interaction        | Paint, Smart paint, and Background people pass the shared interaction and accessibility contracts on Apple and Web.                |
| Release qualification       | The full challenge corpus and the required performance/parity gates pass on declared support tiers.                                |

Milestones are checkpoints; completion of Paint alone does not complete this feature. Implementation tasks belong under the existing epic rather than in an untracked document checklist.

Open review decisions: qualified device/browser tiers; generation latency and memory ceilings; final models and inference encoding; the durable asset destination for each source adapter; whether cloud reconstruction should be a later feature. The PRD proposes local processing as the first-release baseline.
