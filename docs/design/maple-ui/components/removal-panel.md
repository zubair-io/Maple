# Removal Panel and Overlay

**Tier:** Organism · **Status:** experimental Web and Apple implementation, #3941 / #3984 / #1472.

## Purpose

Select an object in a RAW, inspect an AI reconstruction and save it non-destructively. The Remove dock entry takes the control slot on desktop and phone. The same panel exposes Paint, Smart paint and People. The overlay takes the canvas pointer stream while the panel is ready.

## Interaction

Paint records source-framed strokes; Smart paint expands them into an object mask. Add/Subtract, brush radius and whole-stroke undo/redo refine selection. Keep selected area creates protection; protected pixels are excluded from removal. People shows numbered candidates on the image. Likely subjects and uncertain instances start kept; the list labels each role. Only Remove and then Keep can change the accepted image. Box prominence is a suggestion, not background ground truth; the policy remains experimental until labeled scene qualification.

After segmentation, Apple and Web review automatic roles through the shared Rust policy using actual source-framed mask overlap. Prominence and confidence rules are unchanged. A background candidate with an intersecting detector box can stay selected when its mask is disjoint from kept people. Actual overlapping masks stay conservative; missing or empty masks stay uncertain, a missing subject mask keeps possible backgrounds uncertain, and missing uncertain masks fall back to box intersection. This policy does not infer duplicate-person ownership or change manual choices. The Bologna RAW check preselects Person 6 on Apple and produces identical role/keep values through actual browser WASM; this is a scoped workflow check, not corpus or fill-quality qualification (#3941).

On Apple, opening People automatically detects people and applies the shared conservative background suggestions. **People to remove** is a multiple-selection checkbox list: likely background people start checked; subjects and uncertain people start unchecked. Choices are editable through the list and numbered pins. Remove applies pending choices before reconstruction, so there is no Suggest background people or Apply person choices button. Starting refinement also prepares pending choices first. The current Web implementation still exposes those two explicit buttons; porting the Apple interaction remains under #3984 / #1472.

A selected person exposes **Refine Person N**. Add/Subtract paints directly into that person’s mask to include a shadow, reflection, carried object or missed fragment. Other person masks remain independent, and kept subjects stay protected. Whole-gesture Undo/Redo spans person switches; Done refining ends brush input while retaining the selection and history. Applying person choices or successful new detection rebuilds the masks and clears manual refinements. Failed or cancelled replay retains the previous mask and history. Edited masks trim empty borders after excluding protection so erased extent cannot consume the native reconstruction limit.

Remove starts local inference. The proposed pixels remain temporary until Keep. Compare shows the current confirmed photo. Cancel restores its verified saved stack and writes no proposal files. Keep verifies companion publication before confirming XMP. Navigation, model changes and late worker results cannot replace a newer photo's selection. A failed restoration preserves inspection state, disables Keep and offers Retry restoring photo.

On Apple, preparing People choices checks actual mask pixels against kept-person and painted protection. If protection removes any selected pixels, Remove stops before inference and names the overlapping kept people in the selected person's row. Fully protected people have no generation mask and cannot be refined until their choices change. The photographer can change those choices, refine the remaining selection, or explicitly choose **Remove unprotected parts**. This action retains all protection; it does not imply complete removal of the detected person. New choices clear the previous overlap review and are prepared again. Protection subtraction trims empty mask borders before native planning even without painted refinement gestures. The shared mask implementation preserves the exact frame when protection is disjoint and there are no gestures. This Apple interaction still needs the Web panel port under #1472.

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
Apple exposes a status element beside its progress control. The following Mac
keyboard implementation is preserved research under #3984: it builds, but its
live UI test fails before reaching the brush and it is not qualified. **Focus brush**
places keyboard input on the painting canvas. Arrow keys move one screen point;
Shift moves ten. Space starts or finishes one whole stroke, Return paints a point,
and Escape cancels an unfinished stroke. Losing focus also cancels that stroke.
The visible brush cursor and accessible percentage position follow the shared
source-coordinate mapper. The canvas retains focus while a committed selection
is processed and disables painting until ready. Assistive technology can press
the canvas to paint a point and invoke four named brush movement actions.
Keyboard input feeds the same Add/Subtract, protection and whole-gesture history
as pointer input. Web keyboard painting, live VoiceOver qualification and broader
announcements remain tracked by #1472. Accepted Web removal undo/redo uses the normal editor history and announces the action without shifting the canvas. Failed saves retain the current model and history and show an alert even after closing Remove.

## Persistence and scope

Require a writable RAW folder on Apple and Hosted Web, or an authorized Self Hosted server library, and explicitly imported, checksum-verified model files. Self Hosted authoring needs no browser folder handle; inference runs locally and verified companions publish through authenticated HTTP. XMP stores ordered accepted records; `.maple/inpaint/` stores immutable masks and scene-linear patches. Reopening, compatible CPU native-detail tiles and local/server-backed browser exports use verified assets without inference. The original is immutable.

Keep creates one normal editor history entry for the reviewed group. Global undo/redo and whole-model reset confirm the XMP save before changing accepted pixels or moving history. Keep refuses a changed full-XMP revision and retains the candidate. A lost HTTP acknowledgement retains Review; retry confirms an identical saved document without rewriting it or adding another operation. Later external edits refuse that retry and require reopening. Export retains selection, review, history and viewport across CPU RAW-owner retirement; its existing canonical sidecar refresh preserves the reopened edits and accepted records.

Saved rows expose Enable/Disable, Delete and Replace through confirmed history. Later dependent results remain fixed and show Needs review when their context changes. Immutable companions remain available for undo. Missing/corrupt assets fail visibly. Broader native saved-controls and selection qualification, native-detail tiles on WebGPU, remaining transport/Windows consumers, model photographic quality, model distribution and physical-device budgets remain unqualified under #1472.

Apple owns temporary selection and review in `RemovalSession`. Its panel is
available in the Mac/iPad inspector and iPhone controls; a local model folder
is selected through the system picker. On Mac, **Import model folder** copies all four pinned models and the architecture-specific pinned `runtime.dylib` into app-owned Application Support. The complete set is staged and verified before any file is installed; a bad import preserves a valid installation. Copied files are regular files, independent of imported symlinks or external volumes. Reopening the tool verifies and restores this installation. Missing or corrupt models show a reinstall message while Paint selection remains available; Remove stays disabled. Model/runtime files are verified again by native loaders when used. This offline import does not qualify the model quality, licenses or public distribution. Paint uses the shared source-coordinate
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
