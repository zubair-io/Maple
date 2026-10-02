# Removal Panel and Overlay

**Tier:** Organism · **Status:** experimental Web and Apple implementation, #3941 / #3984 / #1472.

## Purpose

Select an object in a RAW, inspect an AI reconstruction and save it non-destructively. The Remove dock entry takes the control slot on desktop and phone. The same panel exposes Paint, Smart paint and People. The overlay takes the canvas pointer stream while the panel is ready.

## Interaction

Paint records source-framed strokes; Smart paint expands them into an object mask. Add/Subtract, brush radius and whole-stroke undo/redo refine selection. Keep selected area creates protection; protected pixels are excluded from removal. People shows numbered candidates on the image and corresponding Keep/Remove buttons. Suggest background people runs the shared conservative prominence policy and prepares masks in one operation. Likely subjects and uncertain instances start kept; the list labels each role. Every Keep/Remove choice is editable through the list and numbered pins, and Apply person choices rebuilds selection/protection. Only Remove and then Keep can change the accepted image. Box prominence is a suggestion, not background ground truth; the policy remains experimental until labeled scene qualification.

A selected person exposes **Refine Person N**. Add/Subtract paints directly into that person’s mask to include a shadow, reflection, carried object or missed fragment. Other person masks remain independent, and kept subjects stay protected. Whole-gesture Undo/Redo spans person switches; Done refining ends brush input while retaining the selection and history. Applying person choices or successful new detection rebuilds the masks and clears manual refinements. Failed or cancelled replay retains the previous mask and history. Edited masks trim empty borders after excluding protection so erased extent cannot consume the native reconstruction limit.

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

Require a writable filesystem RAW folder and explicitly imported, checksum-verified model files. XMP stores ordered accepted records; `.maple/inpaint/` stores immutable masks and scene-linear patches. Reopening, compatible CPU native-detail tiles and local browser exports use verified assets without inference. Export retains selection, review, dedicated undo and viewport across CPU RAW-owner retirement. Missing/corrupt assets fail visibly. The original is immutable. Broader native selection qualification, native-detail tiles on WebGPU, remaining remote/server/Windows consumers, model photographic quality, model distribution and physical-device budgets remain unqualified under #1472.

Apple owns temporary selection and review in `RemovalSession`. Its panel is
available in the Mac/iPad inspector and iPhone controls; a local model folder
is selected through the system picker. Paint uses the shared source-coordinate
rasterizer; Smart paint and People use pinned native SAM/RT-DETR inference.
Selection/protection overlays use the shared inverse RAW geometry. The review
RGB preview overlays the confirmed canvas without retiring its RAW owner, so
Cancel writes nothing and reveals the existing confirmed render. Keep publishes
through the durable history boundary. A full-XMP conflict retains the candidate
and instructs the photographer to reopen the photo before using external edits.
People reconstructs each selected person in its own bounded source window.
Later windows consume earlier temporary patches and record their dependencies.
Keep publishes the ordered group with one XMP commit and one undo entry; a
failed later companion cannot commit a visible prefix. Cancel discards the
whole temporary group. Each individual object must still fit the model's
native extent; large-object reconstruction remains unqualified under #1472.
Native Paint workflow/model tests pass. The macOS app has also exercised Paint,
Compare, Cancel, Keep, undo/redo and reopening on an isolated 39MP photographic
RAW, verifying that the original remains byte-identical and Cancel creates no
draft companions. Smart paint on the same RAW now runs actual segmentation,
Remove, Compare, Cancel and Keep, preserving the exact accepted XMP and
companion set on Cancel. Paint click/drag and selection undo/redo work after
reopening saved removals. Native background-person suggestions automatically protect the portrait
subject and disable Remove when no other person remains. Deliberate
Keep/Remove overrides rebuild the selection and protection without saving. On macOS a native pointer surface delivers brush samples; iOS retains
the SwiftUI drag gesture. Both feed the same shared source-coordinate mapping.
These are single-scene workflow checks. Conservative role suggestions are shared across Apple and Web; failed or cancelled detection/segmentation retains the prior selection and person choices. Corpus qualification of background-role suggestions,
multiple-person photographic scenes, large-object reconstruction and broad
photographic/hardware qualification remain under #1472.

The actual native market detector test returns nine reviewable people: three
likely subjects and six uncertain, all initially kept. The size/overlap policy
therefore still requires corrections in this scene; it is not qualified crowd
background selection. Actual browser CPU/WebGPU checks on the 39MP portrait
exercise automatic subject protection, a deliberate Remove override, and
restoring Keep without writing XMP or changing the original. Manual per-person Subtract, Undo and Redo are also checked through actual retained-RAW worker replies in both browser paths. Native real-file session tests and retained-WASM tests cover Add, protection, separate person windows, cross-person undo and failed replay without history changes. Native refinement UI and physical-device behavior still need qualification. The local
photographic browser gate requires `test_0002.dng` and the pinned models; absent
artifacts fail rather than qualifying the feature.
