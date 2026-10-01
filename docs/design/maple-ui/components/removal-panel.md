# Removal Panel and Overlay

**Tier:** Organism · **Status:** experimental Web and Apple implementation, #3941 / #3984 / #1472.

## Purpose

Select an object in a RAW, inspect an AI reconstruction and save it non-destructively. The Remove dock entry takes the control slot on desktop and phone. The same panel exposes Paint, Smart paint and People. The overlay takes the canvas pointer stream while the panel is ready.

## Interaction

Paint records source-framed strokes; Smart paint expands them into an object mask. Add/Subtract, brush radius and whole-stroke undo/redo refine selection. Keep selected area creates protection; protected pixels are excluded from removal. People shows numbered candidates on the image and corresponding Keep/Remove buttons. The photographer marks keepers before selecting the others; detection does not establish background status.

Remove starts local inference. The proposed pixels remain temporary until Keep. Compare shows the current confirmed photo. Cancel restores its verified saved stack and writes no proposal files. Keep verifies companion publication before confirming XMP. Navigation, model changes and late worker results cannot replace a newer photo's selection. A failed restoration preserves inspection state, disables Keep and offers Retry restoring photo.

## States

- Closed/loading: show the actionable opening error or preparing status.
- Ready/selecting: show selection, protection and numbered candidate overlays; disable conflicting input during segmentation.
- Generating: announce progress and allow cancellation.
- Review: offer Compare, Keep and Cancel.
- Saving: disable conflicting actions until confirmed publication.
- Recovery: retain the draft view and offer restoration retry.

## Variants

Paint records the brush footprint. Smart paint expands strokes with the object
segmenter. People shows detector proposals for explicit keeper review. The same
controls occupy the desktop inspector or the phone's scrollable tool area.

## Tokens used

Compose Maple UI Button, Segmented Toggle and Living Slider. Use generated
primary color for selection and successText for protection; textMuted for
instructions, errorText for projection errors, and surface/border for controls.

## Props

Apple's panel and overlay receive `EditorState` and use its owned
`RemovalSession`. The Web panel injects `RemovalEditorSession`; it has no
external inputs or outputs. Sessions supply phase, mode, temporary masks,
people, model availability, review pixels and confirmed save/error state.

## Accessibility

Number labels match accessible Person N buttons. Brush size exposes its
label/value and adjustable actions. Every selection, review and model action
has an accessible label. The Web operation status is a polite live region;
Apple exposes a status element beside its progress control. Keyboard painting,
broader announcements and Web global undo/history integration remain tracked by #1472.

## Persistence and scope

Require a writable filesystem RAW folder and explicitly imported, checksum-verified model files. XMP stores ordered accepted records; `.maple/inpaint/` stores immutable masks and scene-linear patches. Reopening, compatible CPU native-detail tiles and local browser exports use verified assets without inference. Export retains selection, review, dedicated undo and viewport across CPU RAW-owner retirement. Missing/corrupt assets fail visibly. The original is immutable. Native Smart paint/People UI, native-detail tiles on WebGPU, remaining remote/server/Windows consumers, model photographic quality, model distribution and physical-device budgets remain unqualified under #1472.

Apple owns temporary selection and review in `RemovalSession`. Its panel is
available in the Mac/iPad inspector and iPhone controls; a local model folder
is selected through the system picker. Paint uses the shared source-coordinate
rasterizer; Smart paint and People use pinned native SAM/RT-DETR inference.
Selection/protection overlays use the shared inverse RAW geometry. The review
RGB preview overlays the confirmed canvas without retiring its RAW owner, so
Cancel writes nothing and reveals the existing confirmed render. Keep publishes
through the durable history boundary. A full-XMP conflict retains the candidate
and instructs the photographer to reopen the photo before using external edits.
Native Paint workflow/model tests pass. The macOS app has also exercised Paint,
Compare, Cancel, Keep, undo/redo and reopening on an isolated 39MP photographic
RAW, verifying that the original remains byte-identical and Cancel creates no
XMP or companions. Native Smart paint/People UI, automatic background-role
selection, spread-person generation, photographic and hardware qualification
remain under #1472.
