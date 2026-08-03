// Closing the phone flyout while a field-less colour/effects sub-tool (HSL,
// bwMix, Color Grading) is armed, for EditorShellComponent (#1807 Task 4
// review finding #1). Extracted to keep editor-shell.component.ts under the
// per-file LOC budget, following the same shape as editor-shell-undo.ts: a
// free function operating on the live component through its public surface.
// `import type` keeps this a type-only (no runtime) dependency on the shell.
//
// Both of the phone flyout's close paths — the card's own X button
// (`closeRequest`) and re-tapping the active dock group icon
// (`onPhoneDockGroupChange`) — funnel through `EditorShellComponent
// .closePhoneCard()`, which used to just flip `phoneCardOpen`. That is a
// no-op while a field-less tool is armed: the phone `pro-control-card`'s
// `[closed]` binding is ALSO kept open by `hslArmed()`/`bwMixArmed()`/
// `colorGradeArmed()` (#1807 Task 4's fix for the OLD phone dock's HSL/B&W/
// Grade buttons, which otherwise closed the card out from under the content
// they had just armed). So closing has to escape the armed sub-tool too, not
// just clear the open flag, or the X button visibly does nothing and a
// later "Basic" tap closes the card instead of showing its sliders (the
// stale `phoneCardOpen === false` left behind by the earlier no-op tap).
// Mirrors the control card's own "Basic" chip (`ControlCardComponent
// .onSubtoolClick`) by arming the group's first slider tool directly —
// `EditorStateService.armGroup` can't be used here for the same reason it
// can't there: it retains an already-in-group armed tool.
import type { EditorShellComponent } from './editor-shell.component';
import { TOOLS_IN_GROUP } from '../../editor/tool-model';

export function closePhoneCard(shell: EditorShellComponent): void {
  if (shell.hslArmed() || shell.bwMixArmed() || shell.colorGradeArmed()) {
    shell.editorState.armTool(TOOLS_IN_GROUP[shell.activeGroup()][0]);
  }
  shell.phoneCardOpen.set(false);
  shell.editorState.haptic('switch');
}
