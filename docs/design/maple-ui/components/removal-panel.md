# Removal Panel and Overlay

**Tier:** Organism · **Status:** experimental Web implementation, #3941 / #1472.

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

## Tokens and accessibility

Compose Maple UI Button, Segmented Toggle and Living Slider. Use generated primary color for selection and successText for protection. Number labels match the accessible Person N buttons. Radius exposes its label/value as a slider; operation status is a polite live region. Keyboard painting and global undo/history integration remain tracked by #1472.

## Persistence and scope

Require a writable filesystem RAW folder and explicitly imported, checksum-verified model files. XMP stores ordered accepted records; `.maple/inpaint/` stores immutable masks and scene-linear patches. Reopening and local browser exports use verified assets without inference. Export retains selection, review, dedicated undo and viewport across CPU RAW-owner retirement. Missing/corrupt assets fail visibly. The original is immutable. Apple UI, normal tiles and Apple/server/Windows export consumers, model photographic quality, model distribution and physical-device budgets remain unqualified under #1472.
